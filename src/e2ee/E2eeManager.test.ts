import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vitest } from 'vitest';
import { ParticipantEvent, RoomEvent } from '../room/events';
import { E2EEManager } from './E2eeManager';
import { ExternalE2EEKeyProvider } from './KeyProvider';

describe('E2EEManager sender hold', () => {
  let manager: E2EEManager;
  let posted: object[];

  beforeEach(() => {
    posted = [];
    manager = new E2EEManager(
      {
        keyProvider: new ExternalE2EEKeyProvider(),
        worker: { postMessage: (msg: object) => posted.push(msg) } as unknown as Worker,
      },
      false,
    );
  });

  afterEach(() => {
    vitest.unstubAllGlobals();
  });

  const track = { id: 'camera' } as MediaStreamTrack;

  /** What the browser would send: replaceTrack as the sender's prototype has it. */
  const fakeSender = (initial: MediaStreamTrack | null = track) => {
    const native = vitest.fn(async function (this: RTCRtpSender, next: MediaStreamTrack | null) {
      sender.track = next;
    });
    const sender = { track: initial, replaceTrack: native } as unknown as {
      track: MediaStreamTrack | null;
      replaceTrack: (next: MediaStreamTrack | null) => Promise<void>;
    };
    return { sender, native };
  };

  const hold = (sender: unknown): number => (manager as any).holdSender(sender, 'TR_1');
  const workerSays = (data: object) => (manager as any).onWorkerMessage({ data } as MessageEvent);
  const attached = (holdId: number, trackId = 'TR_1') =>
    workerSays({ kind: 'senderTransformAttached', data: { trackId, holdId } });

  it('takes the track off the sender until the transform is attached', async () => {
    const { sender } = fakeSender();

    const holdId = hold(sender);
    await Promise.resolve();
    expect(sender.track).toBeNull();

    attached(holdId);
    await Promise.resolve();
    expect(sender.track).toBe(track);
  });

  it('sends the check back to the worker, which answers when it gets its turn', () => {
    workerSays({ kind: 'senderTransformCheck', data: { trackId: 'TR_1', holdId: 3 } });

    expect(posted).toEqual([
      { kind: 'senderTransformCheck', data: { trackId: 'TR_1', holdId: 3 } },
    ]);
  });

  it('ignores the report of another track', async () => {
    const { sender } = fakeSender();

    const holdId = hold(sender);
    attached(holdId, 'TR_2');
    await Promise.resolve();

    expect(sender.track).toBeNull();
  });

  describe('another sender of the same track', () => {
    it('ignores a late report for the earlier sender', async () => {
      const first = fakeSender();
      const firstHold = hold(first.sender);
      // unpublished and published again while the first report was on its way
      (manager as any).dropSenderHold('TR_1');
      const second = fakeSender();
      const secondHold = hold(second.sender);

      attached(firstHold);
      await Promise.resolve();
      expect(second.sender.track).toBeNull();

      attached(secondHold);
      await Promise.resolve();
      expect(second.sender.track).toBe(track);
    });

    it('ends a hold that was never cleared and holds the new sender', async () => {
      const first = fakeSender();
      hold(first.sender);
      // e.g. the first publish failed after its sender was created
      const second = fakeSender();
      const secondHold = hold(second.sender);
      await Promise.resolve();

      expect(first.sender.track).toBeNull();
      expect(first.sender.replaceTrack).toBe(first.native);
      expect(second.sender.track).toBeNull();

      attached(secondHold);
      await Promise.resolve();
      expect(first.sender.track).toBeNull();
      expect(second.sender.track).toBe(track);
    });
  });

  describe('room events', () => {
    let room: EventEmitter & { localParticipant: EventEmitter };

    beforeEach(() => {
      room = Object.assign(new EventEmitter(), {
        localParticipant: Object.assign(new EventEmitter(), {
          identity: 'me',
          isE2EEEnabled: true,
        }),
        remoteParticipants: new Map(),
      });
      (manager as any).room = room;
      (manager as any).setupEventListeners(room, new ExternalE2EEKeyProvider());
    });

    it('ends the hold without the track when the track is unpublished', async () => {
      const { sender, native } = fakeSender();
      hold(sender);

      room.localParticipant.emit(ParticipantEvent.LocalTrackUnpublished, {
        track: { mediaStreamID: 'TR_1' },
      });
      await Promise.resolve();

      expect(sender.track).toBeNull();
      expect(sender.replaceTrack).toBe(native);
      expect((manager as any).senderHolds.size).toBe(0);
    });

    it('ends every hold without the track when the room disconnects', async () => {
      const { sender, native } = fakeSender();
      hold(sender);

      room.emit(RoomEvent.Disconnected);
      await Promise.resolve();

      expect(sender.track).toBeNull();
      expect(sender.replaceTrack).toBe(native);
      expect((manager as any).senderHolds.size).toBe(0);
    });
  });

  describe('turning encryption off', () => {
    const inRoom = (isE2EEEnabled: boolean) => {
      (manager as any).room = {
        localParticipant: { identity: 'me', isE2EEEnabled },
        getParticipantByIdentity: () => ({}),
      };
    };

    it('releases a held sender when encryption really is off', async () => {
      const { sender } = fakeSender();
      inRoom(true);
      hold(sender);

      inRoom(false);
      workerSays({ kind: 'enable', data: { enabled: false, participantIdentity: 'me' } });
      await Promise.resolve();

      expect(sender.track).toBe(track);
    });

    it('keeps holding on a late reply from before encryption was turned on', async () => {
      const { sender } = fakeSender();
      inRoom(true);
      const holdId = hold(sender);

      workerSays({ kind: 'enable', data: { enabled: false, participantIdentity: 'me' } });
      await Promise.resolve();
      expect(sender.track).toBeNull();

      attached(holdId);
      await Promise.resolve();
      expect(sender.track).toBe(track);
    });

    it("keeps holding when another participant's encryption goes off", async () => {
      const { sender } = fakeSender();
      inRoom(true);
      hold(sender);

      workerSays({ kind: 'enable', data: { enabled: false, participantIdentity: 'other' } });
      await Promise.resolve();

      expect(sender.track).toBeNull();
    });

    it('holds a new sender only while encryption is on, and gives the transform its id', async () => {
      const options: Array<{ holdId?: number }> = [];
      vitest.stubGlobal(
        'RTCRtpScriptTransform',
        class {
          constructor(_worker: unknown, transformOptions: { holdId?: number }) {
            options.push(transformOptions);
          }
        },
      );
      (window as any).RTCRtpScriptTransform = (globalThis as any).RTCRtpScriptTransform;
      try {
        const encrypted = fakeSender();
        inRoom(true);
        (manager as any).handleSender(encrypted.sender, 'TR_1');
        await Promise.resolve();
        expect(encrypted.sender.track).toBeNull();

        const plain = fakeSender();
        inRoom(false);
        (manager as any).handleSender(plain.sender, 'TR_2');
        await Promise.resolve();
        expect(plain.sender.track).toBe(track);

        // the worker reports with the hold's id, and only for a held sender
        expect(options[0].holdId).toEqual(expect.any(Number));
        expect(options[1].holdId).toBeUndefined();
      } finally {
        delete (window as any).RTCRtpScriptTransform;
      }
    });
  });
});
