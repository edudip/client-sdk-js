import log from '../logger';

let nextHoldId = 0;

/**
 * Keeps the track off a new sender until its transform is attached: WebKit sends frames
 * unencrypted until then (LibWebRTCRtpTransformBackend::Transform).
 */
export class SenderHold {
  readonly id = nextHoldId++;

  private readonly sender: RTCRtpSender;

  private readonly trackId: string;

  private readonly replaceTrack: RTCRtpSender['replaceTrack'];

  private track: MediaStreamTrack | null;

  private readonly heldAt = Date.now();

  constructor(sender: RTCRtpSender, trackId: string) {
    this.sender = sender;
    this.trackId = trackId;
    this.replaceTrack = sender.replaceTrack;
    this.track = sender.track;
    this.replaceTrack
      .call(sender, null)
      .catch((error) => log.warn('could not hold sender', { error }));
    // keep LiveKit's own calls until the release
    sender.replaceTrack = async (track: MediaStreamTrack | null) => {
      this.track = track;
    };
  }

  /** Ends the hold and puts the track on the sender. */
  release() {
    const waitedMs = this.drop();
    if (waitedMs > 1_000) {
      log.warn('sender waited for its encryption transform', { trackId: this.trackId, waitedMs });
    }
    this.sender
      .replaceTrack(this.track)
      .catch((error) => log.warn('could not release sender', { error }));
  }

  /** Ends the hold without sending the track and returns how long the sender was held. */
  drop(): number {
    this.sender.replaceTrack = this.replaceTrack;
    return Date.now() - this.heldAt;
  }
}
