import {
  flushMessageBuffer,
  isLifecycleTopic,
  routeMqttMessage,
  type MqttIngressHandlers,
  type MqttIngressRouterState
} from '@/services/mqttIngressRouter';

function handlers(overrides: Partial<MqttIngressHandlers> = {}): MqttIngressHandlers {
  return {
    onActive: jest.fn().mockResolvedValue(undefined),
    onLwt: jest.fn().mockResolvedValue(undefined),
    onStatus: jest.fn().mockResolvedValue(undefined),
    onScreenEcho: jest.fn().mockResolvedValue(undefined),
    onOther: jest.fn().mockResolvedValue(undefined),
    updateLastSeen: jest.fn().mockResolvedValue(undefined),
    ensureProvisioned: jest.fn().mockResolvedValue(true),
    extractDeviceId: (topic) => {
      const parts = topic.split('/');
      return parts.length >= 3 ? parts[2] : null;
    },
    ...overrides
  };
}

function state(overrides: Partial<MqttIngressRouterState> = {}): MqttIngressRouterState {
  return {
    isServicesReady: true,
    startupTime: Date.now() - 10_000,
    buffer: [],
    ...overrides
  };
}

describe('mqttIngressRouter', () => {
  it('isLifecycleTopic detects active and lwt', () => {
    expect(isLifecycleTopic('proof.mqtt/DEVICE-1/active')).toBe(true);
    expect(isLifecycleTopic('proof.mqtt/DEVICE-1/lwt')).toBe(true);
    expect(isLifecycleTopic('proof.mqtt/DEVICE-1/status')).toBe(false);
  });

  it('routes /active with stale timestamp to onActive', async () => {
    const h = handlers();
    const oldTs = new Date(Date.now() - 890_000).toISOString();
    const payload = Buffer.from(
      JSON.stringify({ type: 'device_registration', timestamp: oldTs })
    );

    await routeMqttMessage(
      'proof.mqtt/DEVICE-19/active',
      payload,
      { retain: false },
      h,
      state()
    );

    expect(h.onActive).toHaveBeenCalledTimes(1);
    expect(h.onStatus).not.toHaveBeenCalled();
  });

  it('drops non-lifecycle message with old timestamp', async () => {
    const h = handlers();
    const oldTs = new Date(Date.now() - 890_000).toISOString();
    const payload = Buffer.from(JSON.stringify({ status: 'online', timestamp: oldTs }));

    await routeMqttMessage(
      'proof.mqtt/DEVICE-19/status',
      payload,
      { retain: false },
      h,
      state()
    );

    expect(h.onStatus).not.toHaveBeenCalled();
  });

  it('buffers non-lifecycle when services not ready', async () => {
    const h = handlers();
    const s = state({ isServicesReady: false });
    const payload = Buffer.from(JSON.stringify({ status: 'online', timestamp: new Date().toISOString() }));

    await routeMqttMessage(
      'proof.mqtt/DEVICE-19/status',
      payload,
      { retain: false },
      h,
      s
    );

    expect(s.buffer).toHaveLength(1);
    expect(h.onStatus).not.toHaveBeenCalled();
  });

  it('flushMessageBuffer processes buffered entries when ready', async () => {
    const h = handlers();
    const s = state({
      isServicesReady: true,
      buffer: [
        {
          topic: 'proof.mqtt/DEVICE-19/status',
          payload: Buffer.from(JSON.stringify({ status: 'online', timestamp: new Date().toISOString() })),
          packet: { retain: false }
        }
      ]
    });

    const count = await flushMessageBuffer(h, s);
    expect(count).toBe(1);
    expect(h.onStatus).toHaveBeenCalledTimes(1);
    expect(s.buffer).toHaveLength(0);
  });
});
