import { afterEach, beforeEach, describe, expect, it, vitest } from 'vitest';
import { E2EEManager } from './E2eeManager';
import { ExternalE2EEKeyProvider } from './KeyProvider';

/** A MediaStreamTrack stand-in whose `enabled` is an accessor on the prototype, like the real one. */
class FakeTrack {
  #enabled = true;

  get enabled() {
    return this.#enabled;
  }

  set enabled(enabled: boolean) {
    this.#enabled = enabled;
  }
}

/** What the browser sees, whatever `enabled` reports to the app. */
const sends = (track: FakeTrack) =>
  Object.getOwnPropertyDescriptor(FakeTrack.prototype, 'enabled')!.get!.call(track);

describe('E2EEManager sender hold', () => {
  let manager: E2EEManager;

  beforeEach(() => {
    vitest.stubGlobal('MediaStreamTrack', FakeTrack);
    manager = new E2EEManager(
      { keyProvider: new ExternalE2EEKeyProvider(), worker: {} as Worker },
      false,
    );
  });

  afterEach(() => {
    vitest.unstubAllGlobals();
  });

  const fakeSender = (track: FakeTrack) => {
    const sender = {
      track,
      replaceTrack: vitest.fn(async function (this: { track: unknown }, next: unknown) {
        sender.track = next as FakeTrack;
      }),
    };
    return sender;
  };

  const workerSays = (data: object) => (manager as any).onWorkerMessage({ data } as MessageEvent);

  it('disables the sent track until the worker reports encrypting', () => {
    const track = new FakeTrack();
    const sender = fakeSender(track);

    (manager as any).holdUntilEncrypting(sender, 'TR_1');

    expect(sends(track)).toBe(false);
    // the app still sees the state it set
    expect(track.enabled).toBe(true);

    workerSays({ kind: 'senderEncrypting', data: { trackId: 'TR_1', participantIdentity: 'me' } });

    expect(sends(track)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(track, 'enabled')).toBeUndefined();
  });

  it('keeps mute and unmute while held and applies the last one on release', () => {
    const track = new FakeTrack();
    (manager as any).holdUntilEncrypting(fakeSender(track), 'TR_1');

    track.enabled = false; // mute
    expect(track.enabled).toBe(false);
    track.enabled = true; // unmute: must not reach the browser yet
    expect(sends(track)).toBe(false);
    track.enabled = false; // mute again

    workerSays({ kind: 'senderEncrypting', data: { trackId: 'TR_1', participantIdentity: 'me' } });

    expect(sends(track)).toBe(false);
    expect(track.enabled).toBe(false);
  });

  it('holds a track given to replaceTrack while held', async () => {
    const first = new FakeTrack();
    const second = new FakeTrack();
    const sender = fakeSender(first);
    const nativeReplace = sender.replaceTrack;
    (manager as any).holdUntilEncrypting(sender, 'TR_1');

    await sender.replaceTrack(second as unknown as MediaStreamTrack);

    expect(nativeReplace).toHaveBeenCalledWith(second);
    expect(sends(second)).toBe(false);

    workerSays({ kind: 'senderEncrypting', data: { trackId: 'TR_1', participantIdentity: 'me' } });

    expect(sends(second)).toBe(true);
    expect(sender.replaceTrack).toBe(nativeReplace);
  });

  it('ignores the report of another track', () => {
    const track = new FakeTrack();
    (manager as any).holdUntilEncrypting(fakeSender(track), 'TR_1');

    workerSays({ kind: 'senderEncrypting', data: { trackId: 'TR_2', participantIdentity: 'me' } });

    expect(sends(track)).toBe(false);
  });

  describe('turning encryption off', () => {
    const inRoom = (isE2EEEnabled: boolean) => {
      (manager as any).room = {
        localParticipant: { identity: 'me', isE2EEEnabled },
        getParticipantByIdentity: () => ({}),
      };
    };

    it('releases a held sender when encryption really is off', () => {
      const track = new FakeTrack();
      inRoom(true);
      (manager as any).holdUntilEncrypting(fakeSender(track), 'TR_1');

      inRoom(false);
      workerSays({ kind: 'enable', data: { enabled: false, participantIdentity: 'me' } });

      expect(sends(track)).toBe(true);
    });

    it('keeps holding on a late reply from before encryption was turned on', () => {
      const track = new FakeTrack();
      inRoom(true);
      (manager as any).holdUntilEncrypting(fakeSender(track), 'TR_1');

      workerSays({ kind: 'enable', data: { enabled: false, participantIdentity: 'me' } });

      expect(sends(track)).toBe(false);

      workerSays({
        kind: 'senderEncrypting',
        data: { trackId: 'TR_1', participantIdentity: 'me' },
      });

      expect(sends(track)).toBe(true);
    });

    it("keeps holding when another participant's encryption goes off", () => {
      const track = new FakeTrack();
      inRoom(true);
      (manager as any).holdUntilEncrypting(fakeSender(track), 'TR_1');

      workerSays({ kind: 'enable', data: { enabled: false, participantIdentity: 'other' } });

      expect(sends(track)).toBe(false);
    });

    it('holds a new sender only while encryption is on', () => {
      vitest.stubGlobal('RTCRtpScriptTransform', class {});
      window.RTCRtpScriptTransform = (globalThis as any).RTCRtpScriptTransform;
      try {
        const encrypted = new FakeTrack();
        inRoom(true);
        (manager as any).handleSender(fakeSender(encrypted), 'TR_1');
        expect(sends(encrypted)).toBe(false);

        const plain = new FakeTrack();
        inRoom(false);
        (manager as any).handleSender(fakeSender(plain), 'TR_2');
        expect(sends(plain)).toBe(true);
      } finally {
        delete (window as any).RTCRtpScriptTransform;
      }
    });
  });

  it('releases every held sender when the room disconnects', () => {
    const track = new FakeTrack();
    (manager as any).holdUntilEncrypting(fakeSender(track), 'TR_1');

    (manager as any).releaseAllSenders();

    expect(sends(track)).toBe(true);
  });
});
