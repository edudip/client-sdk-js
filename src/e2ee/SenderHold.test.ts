import { afterEach, describe, expect, it, vitest } from 'vitest';
import log from '../logger';
import { SenderHold } from './SenderHold';

describe('SenderHold', () => {
  afterEach(() => {
    vitest.useRealTimers();
    vitest.restoreAllMocks();
  });

  const track = { id: 'camera' } as MediaStreamTrack;

  /** What the browser would send: replaceTrack as the sender's prototype has it. */
  const fakeSender = () => {
    const native = vitest.fn(async function (next: MediaStreamTrack | null) {
      sender.track = next;
    });
    const sender = { track, replaceTrack: native } as unknown as {
      track: MediaStreamTrack | null;
      replaceTrack: (next: MediaStreamTrack | null) => Promise<void>;
    };
    return { sender, native };
  };

  const holdOf = (sender: unknown) => new SenderHold(sender as RTCRtpSender, 'TR_1');

  it('takes the track off the sender until the release', async () => {
    const { sender, native } = fakeSender();

    const hold = holdOf(sender);
    await Promise.resolve();
    expect(sender.track).toBeNull();

    hold.release();
    await Promise.resolve();
    expect(sender.track).toBe(track);
    expect(sender.replaceTrack).toBe(native);
  });

  it('keeps a track that LiveKit sets while held off the sender until the release', async () => {
    const { sender } = fakeSender();
    const restarted = { id: 'restarted' } as MediaStreamTrack;

    const hold = holdOf(sender);
    await sender.replaceTrack(restarted);
    await Promise.resolve();
    expect(sender.track).toBeNull();

    hold.release();
    await Promise.resolve();
    expect(sender.track).toBe(restarted);
  });

  it('ends without the track when dropped', async () => {
    const { sender, native } = fakeSender();

    holdOf(sender).drop();
    await Promise.resolve();

    expect(sender.track).toBeNull();
    expect(sender.replaceTrack).toBe(native);
  });

  it('tells how long the sender was held when dropped', () => {
    vitest.useFakeTimers();
    const hold = holdOf(fakeSender().sender);

    vitest.advanceTimersByTime(1_500);

    expect(hold.drop()).toBe(1_500);
  });

  it('gives every hold its own id', () => {
    expect(holdOf(fakeSender().sender).id).not.toBe(holdOf(fakeSender().sender).id);
  });

  it('warns at the release only after a long wait', () => {
    vitest.useFakeTimers();
    const warn = vitest.spyOn(log, 'warn').mockImplementation(() => {});

    holdOf(fakeSender().sender).release();
    expect(warn).not.toHaveBeenCalled();

    const slow = holdOf(fakeSender().sender);
    vitest.advanceTimersByTime(1_500);
    slow.release();
    expect(warn).toHaveBeenCalledWith('sender waited for its encryption transform', {
      trackId: 'TR_1',
      waitedMs: 1_500,
    });
  });
});
