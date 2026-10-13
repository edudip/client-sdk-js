import { ClientInfo_Capability, JoinResponse } from '@livekit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DeviceManager from './DeviceManager';
import Room from './Room';
import { roomConnectOptionDefaults, roomOptionDefaults } from './defaults';
import { RoomEvent } from './events';

describe('Active device switch', () => {
  it('updates devices correctly', async () => {
    const room = new Room();
    await room.switchActiveDevice('audioinput', 'test');
    expect(room.getActiveDevice('audioinput')).toBe('test');
  });
  it('updates devices with exact constraint', async () => {
    const room = new Room();
    await room.switchActiveDevice('audioinput', 'test', true);
    expect(room.getActiveDevice('audioinput')).toBe('test');
  });
  it('emits changed event', async () => {
    const room = new Room();
    let kind: MediaDeviceKind | undefined;
    let deviceId: string | undefined;
    const deviceChangeHandler = (_kind: MediaDeviceKind, _deviceId: string) => {
      kind = _kind;
      deviceId = _deviceId;
    };
    room.on(RoomEvent.ActiveDeviceChanged, deviceChangeHandler);
    await room.switchActiveDevice('audioinput', 'test', true);

    expect(deviceId).toBe('test');
    expect(kind).toBe('audioinput');
  });
});

describe('Default device selection on device changes', () => {
  const device = (kind: MediaDeviceKind, deviceId: string) =>
    ({ kind, deviceId, label: deviceId, groupId: '', toJSON: () => ({}) }) as MediaDeviceInfo;

  /** What LiveKit compares the new device list against: the result of the last enumeration. */
  const setPreviousDevices = (devices: MediaDeviceInfo[]) => {
    (
      DeviceManager.getInstance() as unknown as { _previousDevices: MediaDeviceInfo[] }
    )._previousDevices = devices;
  };

  /** A room whose `kind` was on the first device of `previous` when the list changed to `current`. */
  const roomAfterDeviceChange = (
    kind: MediaDeviceKind,
    previous: MediaDeviceInfo[],
    current: MediaDeviceInfo[],
  ) => {
    const room = new Room();
    room.localParticipant.activeDeviceMap.set(kind, previous[0].deviceId);
    setPreviousDevices(previous);
    vi.spyOn(DeviceManager.getInstance(), 'getDevices').mockResolvedValue(current);
    const switchActiveDevice = vi.spyOn(room, 'switchActiveDevice').mockResolvedValue(true);
    const selectDefaultDevices = () =>
      (room as unknown as { selectDefaultDevices: () => Promise<void> }).selectDefaultDevices();
    return { selectDefaultDevices, switchActiveDevice };
  };

  afterEach(() => {
    vi.restoreAllMocks();
    setPreviousDevices([]);
  });

  it('does not switch the camera when another camera becomes the first one', async () => {
    const facetime = device('videoinput', 'facetime');
    const obs = device('videoinput', 'obs');
    const { selectDefaultDevices, switchActiveDevice } = roomAfterDeviceChange(
      'videoinput',
      [facetime, obs],
      [obs, facetime],
    );

    await selectDefaultDevices();

    expect(switchActiveDevice).not.toHaveBeenCalled();
  });

  it('still switches the microphone when another microphone becomes the first one', async () => {
    const builtIn = device('audioinput', 'built-in');
    const headset = device('audioinput', 'headset');
    const { selectDefaultDevices, switchActiveDevice } = roomAfterDeviceChange(
      'audioinput',
      [builtIn, headset],
      [headset, builtIn],
    );

    await selectDefaultDevices();

    expect(switchActiveDevice).toHaveBeenCalledWith('audioinput', 'headset');
  });
});

describe('Room signaling options', () => {
  it('advertises packet trailer capability when E2EE can handle trailers', async () => {
    const room = new Room();
    const join = vi.fn().mockResolvedValue({
      joinResponse: new JoinResponse({
        room: { name: 'test-room', sid: 'room-sid' },
        participant: { sid: 'participant-sid', identity: 'test-user' },
      }),
      serverInfo: { version: '1.0.0' },
    });
    const engine = { join };

    (
      room as unknown as {
        e2eeManager: unknown;
        connectSignal: (
          url: string,
          token: string,
          engine: unknown,
          connectOptions: typeof roomConnectOptionDefaults,
          roomOptions: typeof roomOptionDefaults,
          abortController: AbortController,
        ) => Promise<JoinResponse>;
      }
    ).e2eeManager = {};

    await (
      room as unknown as {
        connectSignal: (
          url: string,
          token: string,
          engine: unknown,
          connectOptions: typeof roomConnectOptionDefaults,
          roomOptions: typeof roomOptionDefaults,
          abortController: AbortController,
        ) => Promise<JoinResponse>;
      }
    ).connectSignal(
      'wss://test.livekit.io',
      'test-token',
      engine,
      roomConnectOptionDefaults,
      roomOptionDefaults,
      new AbortController(),
    );

    expect(join).toHaveBeenCalledWith(
      'wss://test.livekit.io',
      'test-token',
      expect.objectContaining({
        clientInfoCapabilities: [
          ClientInfo_Capability.CAP_PACKET_TRAILER,
          ClientInfo_Capability.CAP_COMPRESSION_DEFLATE_RAW,
        ],
        e2eeEnabled: true,
      }),
      expect.any(AbortSignal),
      false,
    );
  });
});

describe('Room lifecycle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // Tear down the mocked mediaDevices so other tests see the env they
    // expected (happy-dom does not provide navigator.mediaDevices by default).
    if ((navigator as { mediaDevices?: unknown }).mediaDevices) {
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: undefined,
      });
    }
  });

  it('wraps the constructor-registered devicechange listener in a WeakRef so the Room is GC-eligible (#1940)', async () => {
    // happy-dom does not provide navigator.mediaDevices. Install a minimal
    // EventTarget stand-in so the constructor takes the listener-registration
    // branch and we can observe the registered listener.
    const mediaDevices = new EventTarget() as EventTarget & {
      addEventListener: EventTarget['addEventListener'];
      removeEventListener: EventTarget['removeEventListener'];
    };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: mediaDevices,
    });

    const addSpy = vi.spyOn(mediaDevices, 'addEventListener');
    const derefSpy = vi.spyOn(WeakRef.prototype, 'deref');
    const cleanupRegistrySpy = Room.cleanupRegistry
      ? vi.spyOn(Room.cleanupRegistry, 'register')
      : undefined;

    const room = new Room();
    const handleDeviceChangeSpy = vi.spyOn(
      room as unknown as { handleDeviceChange: (ev: Event) => void },
      'handleDeviceChange',
    );

    // Constructor must register exactly one devicechange listener with AbortSignal teardown.
    const deviceChangeAdds = addSpy.mock.calls.filter(([type]) => type === 'devicechange');
    expect(deviceChangeAdds).toHaveLength(1);
    const listener = deviceChangeAdds[0][1] as EventListener;
    const addOptions = deviceChangeAdds[0][2] as AddEventListenerOptions | undefined;
    expect(addOptions?.signal).toBeInstanceOf(AbortSignal);

    // FinalizationRegistry must be registered with the Room as the target so the
    // cleanup callback fires when the user drops their Room reference.
    if (Room.cleanupRegistry) {
      expect(cleanupRegistrySpy).toHaveBeenCalledWith(room, expect.any(Function));
    }

    // While the WeakRef still derefs to the Room, the listener forwards to handleDeviceChange.
    listener.call(null, new Event('devicechange'));
    expect(handleDeviceChangeSpy).toHaveBeenCalledTimes(1);

    // Simulate the Room being GC'd by forcing deref to return undefined; the
    // listener must short-circuit instead of calling handleDeviceChange.
    derefSpy.mockReturnValue(undefined);
    listener.call(null, new Event('devicechange'));
    expect(handleDeviceChangeSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to a direct devicechange listener when WeakRef/FinalizationRegistry are unavailable (#1944)', async () => {
    const mediaDevices = new EventTarget() as EventTarget & {
      addEventListener: EventTarget['addEventListener'];
      removeEventListener: EventTarget['removeEventListener'];
    };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: mediaDevices,
    });

    // Simulate a legacy browser by stubbing out cleanupRegistry.
    const originalRegistry = Room.cleanupRegistry;
    Object.defineProperty(Room, 'cleanupRegistry', {
      configurable: true,
      value: false,
    });

    try {
      const addSpy = vi.spyOn(mediaDevices, 'addEventListener');
      const room = new Room();
      const handleDeviceChange = (room as unknown as { handleDeviceChange: () => void })
        .handleDeviceChange;

      const deviceChangeAdds = addSpy.mock.calls.filter(([type]) => type === 'devicechange');
      expect(deviceChangeAdds).toHaveLength(1);
      // The registered listener is the bare handleDeviceChange method (no WeakRef closure).
      expect(deviceChangeAdds[0][1]).toBe(handleDeviceChange);
    } finally {
      Object.defineProperty(Room, 'cleanupRegistry', {
        configurable: true,
        value: originalRegistry,
      });
    }
  });
});
