import { afterEach, beforeEach, describe, expect, it, vitest } from 'vitest';
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

  const hold = (sender: unknown) => (manager as any).holdUntilAttached(sender, 'TR_1');
  const workerSays = (data: object) => (manager as any).onWorkerMessage({ data } as MessageEvent);
  const attached = () => workerSays({ kind: 'senderTransformAttached', data: { trackId: 'TR_1' } });

  it('takes the track off the sender until the transform is attached', async () => {
    const { sender } = fakeSender();

    hold(sender);
    await Promise.resolve();
    expect(sender.track).toBeNull();

    attached();
    await Promise.resolve();
    expect(sender.track).toBe(track);
  });

  it('sends the check back to the worker, which answers when it gets its turn', () => {
    workerSays({ kind: 'senderTransformCheck', data: { trackId: 'TR_1' } });

    expect(posted).toEqual([{ kind: 'senderTransformCheck', data: { trackId: 'TR_1' } }]);
  });

  it('keeps a track that LiveKit sets while held off the sender until release', async () => {
    const { sender, native } = fakeSender();
    const restarted = { id: 'restarted' } as MediaStreamTrack;

    hold(sender);
    await sender.replaceTrack(restarted);
    await Promise.resolve();
    expect(sender.track).toBeNull();

    attached();
    await Promise.resolve();
    expect(sender.track).toBe(restarted);
    expect(sender.replaceTrack).toBe(native);
  });

  it('ignores the report of another track', async () => {
    const { sender } = fakeSender();

    hold(sender);
    workerSays({ kind: 'senderTransformAttached', data: { trackId: 'TR_2' } });
    await Promise.resolve();

    expect(sender.track).toBeNull();
  });

  it('does not put the track back on a sender that went away', async () => {
    const { sender, native } = fakeSender();

    hold(sender);
    (manager as any).releaseAllSenders(false);
    await Promise.resolve();

    expect(sender.track).toBeNull();
    expect(sender.replaceTrack).toBe(native);
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
      hold(sender);

      workerSays({ kind: 'enable', data: { enabled: false, participantIdentity: 'me' } });
      await Promise.resolve();
      expect(sender.track).toBeNull();

      attached();
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

    it('holds a new sender only while encryption is on', async () => {
      vitest.stubGlobal('RTCRtpScriptTransform', class {});
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
      } finally {
        delete (window as any).RTCRtpScriptTransform;
      }
    });
  });
});
