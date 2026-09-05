jest.mock('@/models/Device', () => ({
  Device: { findOne: jest.fn() },
  DeviceStatus: { PROVISIONED: 'PROVISIONED', ACTIVE: 'ACTIVE' }
}));

jest.mock('@/models/LoyaltySession', () => ({
  LoyaltySession: {
    create: jest.fn(),
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    find: jest.fn(),
    exists: jest.fn()
  },
  LoyaltySessionStatus: {
    CREATED: 'CREATED',
    READY: 'READY',
    SPINNING: 'SPINNING',
    COMPLETED: 'COMPLETED',
    EXPIRED: 'EXPIRED'
  },
  LOYALTY_ACTIVE_SESSION_STATUSES: ['CREATED', 'READY', 'SPINNING']
}));

jest.mock('@/models/LoyaltySpin', () => ({
  LoyaltySpin: {
    create: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
    findOneAndUpdate: jest.fn(),
    exists: jest.fn()
  },
  LoyaltySpinStatus: {
    CREATED: 'CREATED',
    COMMAND_PUBLISHED: 'COMMAND_PUBLISHED',
    ACK_RECEIVED: 'ACK_RECEIVED',
    REVEALED: 'REVEALED',
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED'
  },
  LOYALTY_IN_FLIGHT_SPIN_STATUSES: ['CREATED', 'COMMAND_PUBLISHED', 'ACK_RECEIVED']
}));

jest.mock('@/services/loyaltyMetrics', () => ({
  observeLoyaltyAckLatencyMs: jest.fn(),
  observeLoyaltyDeviceAckSkewMs: jest.fn(),
  incLoyaltySpinFailure: jest.fn(),
  incLoyaltySessionExpiry: jest.fn(),
  incLoyaltyClockDriftWarn: jest.fn()
}));

import { Device } from '@/models/Device';
import { LoyaltySession } from '@/models/LoyaltySession';
import { LoyaltySpin } from '@/models/LoyaltySpin';
import { LoyaltyHttpError } from '@/utils/loyaltyErrors';
import { LoyaltyService, parseLoyaltyAckDeviceId } from '@/services/loyaltyService';
import type { LoyaltyConfig } from '@/config/loyaltyConfig';

const loyaltyConfig: LoyaltyConfig = {
  ttlMs: 5000,
  sessionTtlMs: 45_000,
  ackTimeoutMs: 5000,
  createdSupersedeMs: 10_000,
  commandTtlMs: 10_000,
  spinSecret: 'test-secret',
  previewOriginPattern: ''
};

const liveServices: LoyaltyService[] = [];

function makeService(overrides?: { publish?: jest.Mock; connected?: boolean; onIdle?: () => void }) {
  const publish = overrides?.publish ?? jest.fn().mockResolvedValue(undefined);
  const mqtt = {
    publish,
    isConnected: () => overrides?.connected ?? true
  };
  const getActiveDevice = jest.fn().mockResolvedValue({ deviceId: 'DEVICE-17' });
  const service = new LoyaltyService({
    mqtt,
    config: loyaltyConfig,
    topicRoot: 'proof.mqtt',
    getActiveDevice,
    onIdle: overrides?.onIdle
  });
  liveServices.push(service);
  return { service, publish, getActiveDevice };
}

function spinDoc(over: Record<string, unknown> = {}) {
  return {
    spinId: 'spin_1',
    sessionId: 'ls_1',
    deviceId: 'DEVICE-17',
    result: { digits: [7, 7, 7], value: '777', reward: 'Free Item' },
    status: 'CREATED',
    idempotencyKey: 'key-1',
    ttlMs: 5000,
    save: jest.fn().mockResolvedValue(undefined),
    ...over
  };
}

describe('LoyaltyService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (Device.findOne as jest.Mock).mockReturnValue({
      lean: jest.fn().mockResolvedValue({ clientId: 'DEVICE-17', status: 'ACTIVE' })
    });
    (LoyaltySession.findOneAndUpdate as jest.Mock).mockResolvedValue(null);
    (LoyaltySession.create as jest.Mock).mockResolvedValue({});
    (LoyaltySession.exists as jest.Mock).mockResolvedValue(null);
    (LoyaltySession.find as jest.Mock).mockResolvedValue([]);
    (LoyaltySpin.findOne as jest.Mock).mockResolvedValue(null);
    (LoyaltySpin.find as jest.Mock).mockResolvedValue([]);
    (LoyaltySpin.exists as jest.Mock).mockResolvedValue(null);
    (LoyaltySpin.findOneAndUpdate as jest.Mock).mockImplementation(async (_q, update) => {
      const set = update?.$set || {};
      return { status: set.status, failCode: set.failCode, failMessage: set.failMessage };
    });
  });

  afterEach(() => {
    for (const s of liveServices) s.stop();
    liveServices.length = 0;
  });

  it('join returns 503 when device is not in the active cache', async () => {
    const { service, getActiveDevice } = makeService();
    getActiveDevice.mockResolvedValue(null);
    await expect(service.join('DEVICE-17')).rejects.toMatchObject({
      status: 503,
      code: 'DEVICE_OFFLINE'
    });
  });

  it('maps duplicate-key on join to 409 ACTIVE_SESSION_EXISTS', async () => {
    const { service } = makeService();
    const err = Object.assign(new Error('E11000'), { code: 11000, keyPattern: { deviceId: 1 } });
    (LoyaltySession.create as jest.Mock).mockRejectedValue(err);
    await expect(service.join('DEVICE-17')).rejects.toMatchObject({
      status: 409,
      code: 'ACTIVE_SESSION_EXISTS'
    });
  });

  it('publishes spin-start on MQTT when session is CREATED and WS is not connected', async () => {
    const { service, publish } = makeService();
    const session = {
      sessionId: 'ls_1',
      deviceId: 'DEVICE-17',
      status: 'CREATED',
      expiresAt: new Date(Date.now() + 60_000)
    };
    (LoyaltySession.findOne as jest.Mock).mockResolvedValue(session);
    const created = spinDoc();
    (LoyaltySpin.create as jest.Mock).mockResolvedValue(created);
    (LoyaltySession.findOneAndUpdate as jest.Mock).mockResolvedValue({
      ...session,
      status: 'SPINNING'
    });

    const body = await service.spin({
      sessionId: 'ls_1',
      idempotencyKey: 'k',
      spinId: 'spin_1',
      result: { digits: [7, 7, 7], value: '777', reward: 'Free Item' }
    });

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: 'proof.mqtt/DEVICE-17/loyalty',
        qos: 2
      })
    );
    const payload = JSON.parse(publish.mock.calls[0][0].payload);
    expect(payload.type).toBe('spin-start');
    expect(payload.result).toEqual({ digits: [7, 7, 7], value: '777', reward: 'Free Item' });
    expect(body.status).toBe('command_published');
    expect(created.status).toBe('COMMAND_PUBLISHED');
  });

  it('retries MQTT when idempotency hits an unpublished CREATED spin', async () => {
    const { service, publish } = makeService();
    const existing = spinDoc({
      status: 'CREATED',
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 10_000)
    });
    (LoyaltySpin.findOne as jest.Mock).mockResolvedValue(existing);
    (LoyaltySession.findOne as jest.Mock).mockResolvedValue({
      sessionId: 'ls_1',
      deviceId: 'DEVICE-17',
      status: 'CREATED',
      expiresAt: new Date(Date.now() + 60_000)
    });
    (LoyaltySession.findOneAndUpdate as jest.Mock).mockResolvedValue({ status: 'SPINNING' });

    const body = await service.spin({
      sessionId: 'ls_1',
      idempotencyKey: 'key-1',
      spinId: 'spin_1',
      result: { digits: [7, 7, 7], value: '777', reward: 'Free Item' }
    });

    expect(LoyaltySpin.create).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'proof.mqtt/DEVICE-17/loyalty', qos: 2 })
    );
    expect(body.status).toBe('command_published');
  });

  it('rejects invalid result and does not invent digits', async () => {
    const { service } = makeService();
    await expect(
      service.spin({
        sessionId: 'ls_1',
        idempotencyKey: 'k',
        spinId: 'spin_1',
        result: { digits: [1, 2], value: '12', reward: 'X' } as never
      })
    ).rejects.toBeInstanceOf(LoyaltyHttpError);
  });

  it('publishes MQTT on {topicRoot}/{id}/loyalty with posted result and rolls back on publish failure', async () => {
    const publish = jest.fn().mockRejectedValue(new Error('broker down'));
    const { service } = makeService({ publish });
    const session = {
      sessionId: 'ls_1',
      deviceId: 'DEVICE-17',
      status: 'READY',
      expiresAt: new Date(Date.now() + 60_000)
    };
    (LoyaltySession.findOne as jest.Mock).mockResolvedValue(session);
    service.activeConnections.set('DEVICE-17', {
      sessionId: 'ls_1',
      socket: { send: jest.fn(), close: jest.fn(), readyState: 1 },
      expiresAt: session.expiresAt
    });
    const created = spinDoc();
    (LoyaltySpin.create as jest.Mock).mockResolvedValue(created);
    (LoyaltySession.findOneAndUpdate as jest.Mock).mockResolvedValue({ ...session, status: 'SPINNING' });

    await expect(
      service.spin({
        sessionId: 'ls_1',
        idempotencyKey: 'k',
        spinId: 'spin_1',
        result: { digits: [7, 7, 7], value: '777', reward: 'Free Item' }
      })
    ).rejects.toMatchObject({ status: 503, code: 'MQTT_PUBLISH_FAILED' });

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: 'proof.mqtt/DEVICE-17/loyalty',
        qos: 2
      })
    );
    const payload = JSON.parse(publish.mock.calls[0][0].payload);
    expect(payload.result).toEqual({ digits: [7, 7, 7], value: '777', reward: 'Free Item' });
    expect(payload.issuedAt).toBeDefined();
    expect(payload.expiresAt).toBeDefined();
    expect(created.status).toBe('FAILED');
  });

  it('returns existing spin on idempotencyKey hit without publishing MQTT', async () => {
    const { service, publish } = makeService();
    (LoyaltySpin.findOne as jest.Mock).mockResolvedValue(
      spinDoc({ status: 'COMMAND_PUBLISHED', commandPublishedAt: new Date() })
    );
    const body = await service.spin({
      sessionId: 'ls_1',
      idempotencyKey: 'key-1',
      spinId: 'spin_other',
      result: { digits: [7, 7, 7], value: '777', reward: 'Free Item' }
    });
    expect(body.spinId).toBe('spin_1');
    expect(body.result).toEqual({ digits: [7, 7, 7], value: '777', reward: 'Free Item' });
    expect(publish).not.toHaveBeenCalled();
  });

  it('publishes when an existing row has command_published status but no commandPublishedAt', async () => {
    const { service, publish } = makeService();
    const existing = spinDoc({
      status: 'command_published',
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 10_000)
    });
    (LoyaltySpin.findOne as jest.Mock).mockResolvedValue(existing);
    (LoyaltySession.findOne as jest.Mock).mockResolvedValue({
      sessionId: 'ls_1',
      deviceId: 'DEVICE-17',
      status: 'CREATED',
      expiresAt: new Date(Date.now() + 60_000)
    });
    (LoyaltySession.findOneAndUpdate as jest.Mock).mockResolvedValue({ status: 'SPINNING' });

    const body = await service.spin({
      sessionId: 'ls_1',
      idempotencyKey: 'key-1',
      spinId: 'spin_1',
      result: { digits: [7, 7, 7], value: '777', reward: 'Free Item' }
    });

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'proof.mqtt/DEVICE-17/loyalty', qos: 2 })
    );
    expect(body.status).toBe('command_published');
  });

  it('fills result and ttlMs on a sparse existing row so save succeeds after MQTT', async () => {
    const { service, publish } = makeService();
    const existing = spinDoc({
      status: 'created',
      result: undefined,
      ttlMs: undefined,
      issuedAt: undefined,
      expiresAt: undefined
    });
    (LoyaltySpin.findOne as jest.Mock).mockResolvedValue(existing);
    (LoyaltySession.findOne as jest.Mock).mockResolvedValue({
      sessionId: 'ls_1',
      deviceId: 'DEVICE-17',
      status: 'CREATED',
      expiresAt: new Date(Date.now() + 60_000)
    });
    (LoyaltySession.findOneAndUpdate as jest.Mock).mockResolvedValue({ status: 'SPINNING' });

    const posted = { digits: [7, 7, 7], value: '777', reward: 'Free Item' };
    const body = await service.spin({
      sessionId: 'ls_1',
      idempotencyKey: 'key-1',
      spinId: 'spin_1',
      result: posted
    });

    expect(publish).toHaveBeenCalled();
    const payload = JSON.parse(publish.mock.calls[0][0].payload);
    expect(payload.result).toEqual(posted);
    expect(existing.result).toEqual(posted);
    expect(existing.ttlMs).toBe(5000);
    expect(LoyaltySpin.findOneAndUpdate).toHaveBeenCalled();
    expect(body.status).toBe('command_published');
  });

  it('maps spinId duplicate with different payload to SPIN_ID_CONFLICT', async () => {
    const { service } = makeService();
    const session = {
      sessionId: 'ls_1',
      deviceId: 'DEVICE-17',
      status: 'READY',
      expiresAt: new Date(Date.now() + 60_000)
    };
    (LoyaltySession.findOne as jest.Mock).mockResolvedValue(session);
    service.activeConnections.set('DEVICE-17', {
      sessionId: 'ls_1',
      socket: { send: jest.fn(), close: jest.fn(), readyState: 1 },
      expiresAt: session.expiresAt
    });
    (LoyaltySpin.create as jest.Mock).mockRejectedValue(
      Object.assign(new Error('E11000'), { code: 11000, keyPattern: { spinId: 1 } })
    );
    (LoyaltySpin.findOne as jest.Mock)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        spinDoc({
          sessionId: 'ls_other',
          result: { digits: [0, 0, 0], value: '000', reward: 'Nope' }
        })
      );

    await expect(
      service.spin({
        sessionId: 'ls_1',
        idempotencyKey: 'k-new',
        spinId: 'spin_1',
        result: { digits: [7, 7, 7], value: '777', reward: 'Free Item' }
      })
    ).rejects.toMatchObject({ status: 409, code: 'SPIN_ID_CONFLICT' });
  });

  it('streams loyalty.spin.started with serverNow and no result; GET omits result until ack', async () => {
    const { service } = makeService();
    const send = jest.fn();
    service.activeConnections.set('DEVICE-17', {
      sessionId: 'ls_1',
      socket: { send, close: jest.fn(), readyState: 1 },
      expiresAt: new Date(Date.now() + 60_000)
    });
    const created = spinDoc({
      status: 'COMMAND_PUBLISHED',
      commandPublishedAt: new Date(),
      ackReceivedAt: undefined,
      result: undefined,
      ttlMs: undefined
    });
    (LoyaltySpin.findOne as jest.Mock).mockResolvedValue(created);
    (LoyaltySession.findOne as jest.Mock).mockResolvedValue({
      sessionId: 'ls_1',
      status: 'SPINNING'
    });
    (LoyaltySpin.findOneAndUpdate as jest.Mock).mockResolvedValue({
      spinId: 'spin_1',
      status: 'ACK_RECEIVED',
      ackReceivedAt: new Date()
    });

    await service.handleAck('proof.mqtt/DEVICE-17/ack', {
      type: 'spin-ack',
      spinId: 'spin_1',
      startedAt: new Date().toISOString(),
      ttlMs: 5000
    });

    expect(JSON.parse(send.mock.calls[0][0])).toEqual(
      expect.objectContaining({
        event: 'loyalty.spin.started',
        spinId: 'spin_1',
        ttlMs: 5000
      })
    );
    const started = JSON.parse(send.mock.calls[0][0]);
    expect(started.result).toBeUndefined();
    expect(started.serverNow).toMatch(/Z$/);
    expect(started.revealAt).toBeDefined();

    (LoyaltySpin.findOne as jest.Mock).mockResolvedValue(
      spinDoc({ ackReceivedAt: undefined, status: 'COMMAND_PUBLISHED' })
    );
    const before = await service.getSpin('spin_1');
    expect(before.result).toBeUndefined();

    (LoyaltySpin.findOne as jest.Mock).mockResolvedValue(
      spinDoc({ ackReceivedAt: new Date(), status: 'ACK_RECEIVED' })
    );
    const after = await service.getSpin('spin_1');
    expect(after.result).toEqual({ digits: [7, 7, 7], value: '777', reward: 'Free Item' });
  });

  it('handleAck accepts lowercase created status and pushes loyalty.spin.started', async () => {
    const { service } = makeService();
    const send = jest.fn();
    service.activeConnections.set('DEVICE-17', {
      sessionId: 'ls_1',
      socket: { send, close: jest.fn(), readyState: 1 },
      expiresAt: new Date(Date.now() + 60_000)
    });
    const created = spinDoc({ status: 'created', ttlMs: 5000 });
    (LoyaltySpin.findOne as jest.Mock).mockResolvedValue(created);
    (LoyaltySession.findOne as jest.Mock).mockResolvedValue({
      sessionId: 'ls_1',
      status: 'SPINNING'
    });
    (LoyaltySpin.findOneAndUpdate as jest.Mock).mockResolvedValue({
      spinId: 'spin_1',
      status: 'ACK_RECEIVED'
    });

    await service.handleAck('proof.mqtt/DEVICE-17/ack', {
      type: 'spin-ack',
      spinId: 'spin_1',
      startedAt: new Date().toISOString(),
      ttlMs: 5000
    });

    expect(JSON.parse(send.mock.calls[0][0]).event).toBe('loyalty.spin.started');
    expect(LoyaltySpin.findOneAndUpdate).toHaveBeenCalled();
  });

  it('ack timeout marks FAILED and emits loyalty.spin.failed', async () => {
    const { service } = makeService();
    const send = jest.fn();
    service.activeConnections.set('DEVICE-17', {
      sessionId: 'ls_1',
      socket: { send, close: jest.fn(), readyState: 1 },
      expiresAt: new Date(Date.now() + 60_000)
    });
    const stale = spinDoc({
      status: 'COMMAND_PUBLISHED',
      commandPublishedAt: new Date(Date.now() - 10_000)
    });
    (LoyaltySpin.find as jest.Mock)
      .mockResolvedValueOnce([stale])
      .mockResolvedValueOnce([]);
    (LoyaltySession.findOneAndUpdate as jest.Mock).mockResolvedValue({});

    await service.sweepAckTimeouts();

    expect(stale.status).toBe('FAILED');
    expect(JSON.parse(send.mock.calls[0][0]).event).toBe('loyalty.spin.failed');
  });

  it('rejects WS attach when mapped sessionId mismatches', async () => {
    const { service } = makeService();
    service.activeConnections.set('DEVICE-17', {
      sessionId: 'ls_old',
      socket: { send: jest.fn(), close: jest.fn(), readyState: 1 },
      expiresAt: new Date(Date.now() + 60_000)
    });
    (LoyaltySession.findOne as jest.Mock).mockResolvedValue({
      sessionId: 'ls_new',
      deviceId: 'DEVICE-17',
      status: 'CREATED',
      expiresAt: new Date(Date.now() + 60_000),
      save: jest.fn()
    });
    await expect(
      service.attachWs('ls_new', { send: jest.fn(), close: jest.fn(), readyState: 1 })
    ).rejects.toMatchObject({ code: 'SESSION_MISMATCH' });
  });

  it('keeps spin COMMAND_PUBLISHED across MQTT reconnect; ack still handled', async () => {
    const { service } = makeService();
    const created = spinDoc({ status: 'COMMAND_PUBLISHED', commandPublishedAt: new Date() });
    (LoyaltySpin.findOne as jest.Mock).mockResolvedValue(created);
    (LoyaltySession.findOne as jest.Mock).mockResolvedValue({ sessionId: 'ls_1', status: 'SPINNING' });
    (LoyaltySpin.findOneAndUpdate as jest.Mock).mockResolvedValue({
      spinId: 'spin_1',
      status: 'ACK_RECEIVED'
    });
    await service.handleAck('proof.mqtt/DEVICE-17/ack', {
      type: 'spin-ack',
      spinId: 'spin_1',
      startedAt: new Date().toISOString(),
      ttlMs: 5000
    });
    expect(LoyaltySpin.findOneAndUpdate).toHaveBeenCalled();
  });

  it('parses ack deviceId from MQTT_TOPIC_ROOT and ignores the old device/ prefix', () => {
    expect(parseLoyaltyAckDeviceId('proof.mqtt/DEVICE-17/ack', 'proof.mqtt')).toBe('DEVICE-17');
    expect(parseLoyaltyAckDeviceId('device/DEVICE-17/ack', 'proof.mqtt')).toBeNull();
    expect(parseLoyaltyAckDeviceId('proof.mqtt/DEVICE-17/loyalty', 'proof.mqtt')).toBeNull();
  });

  it('ignores OTA rollback handshake payloads on the shared ack topic', async () => {
    const { service } = makeService();
    (LoyaltySpin.findOne as jest.Mock).mockResolvedValue(spinDoc({ status: 'COMMAND_PUBLISHED' }));
    await service.handleAck('proof.mqtt/DEVICE-17/ack', {
      cmd: 'ota_rollback_received',
      version: '4.3.1'
    });
    expect(LoyaltySpin.findOne).not.toHaveBeenCalled();
  });

  it('maps deviceId duplicate-key on spin insert to 409 SPIN_IN_PROGRESS', async () => {
    const { service } = makeService();
    const session = {
      sessionId: 'ls_1',
      deviceId: 'DEVICE-17',
      status: 'READY',
      expiresAt: new Date(Date.now() + 60_000)
    };
    (LoyaltySession.findOne as jest.Mock).mockResolvedValue(session);
    service.activeConnections.set('DEVICE-17', {
      sessionId: 'ls_1',
      socket: { send: jest.fn(), close: jest.fn(), readyState: 1 },
      expiresAt: session.expiresAt
    });
    (LoyaltySpin.create as jest.Mock).mockRejectedValue(
      Object.assign(new Error('E11000'), { code: 11000, keyPattern: { deviceId: 1 } })
    );
    await expect(
      service.spin({
        sessionId: 'ls_1',
        idempotencyKey: 'k-new',
        spinId: 'spin_2',
        result: { digits: [1, 2, 3], value: '123', reward: 'X' }
      })
    ).rejects.toMatchObject({ status: 409, code: 'SPIN_IN_PROGRESS' });
  });

  it('join 11000 after stale CREATED supersede still returns 409', async () => {
    const { service } = makeService();
    (LoyaltySession.findOneAndUpdate as jest.Mock).mockResolvedValue({ status: 'EXPIRED' });
    (LoyaltySession.create as jest.Mock).mockRejectedValue(
      Object.assign(new Error('E11000'), { code: 11000, keyPattern: { deviceId: 1 } })
    );
    await expect(service.join('DEVICE-17')).rejects.toMatchObject({
      status: 409,
      code: 'ACTIVE_SESSION_EXISTS'
    });
    expect(LoyaltySession.findOneAndUpdate).toHaveBeenCalled();
  });

  it('fails CREATED spins with no commandPublishedAt (crash between insert and MQTT)', async () => {
    const { service } = makeService();
    const orphan = spinDoc({
      status: 'CREATED',
      createdAt: new Date(Date.now() - 10_000),
      commandPublishedAt: undefined
    });
    (LoyaltySpin.find as jest.Mock).mockResolvedValueOnce([orphan]).mockResolvedValueOnce([]);
    await service.sweepAckTimeouts();
    expect(orphan.status).toBe('FAILED');
    expect(LoyaltySpin.findOneAndUpdate).toHaveBeenCalled();
  });

  it('promotes ACK_RECEIVED past revealAt to REVEALED then COMPLETED', async () => {
    const { service } = makeService();
    const due = spinDoc({
      status: 'ACK_RECEIVED',
      revealAt: new Date(Date.now() - 5_000)
    });
    (LoyaltySpin.find as jest.Mock).mockResolvedValueOnce([]).mockResolvedValueOnce([due]);
    (LoyaltySession.findOneAndUpdate as jest.Mock).mockResolvedValue({});
    await service.sweepAckTimeouts();
    expect(due.status).toBe('COMPLETED');
  });

  it('recovers SPINNING session on WS attach when no in-flight spin exists', async () => {
    const { service } = makeService();
    const session = {
      sessionId: 'ls_1',
      deviceId: 'DEVICE-17',
      status: 'SPINNING',
      expiresAt: new Date(Date.now() + 60_000),
      save: jest.fn().mockResolvedValue(undefined)
    };
    (LoyaltySession.findOne as jest.Mock).mockResolvedValue(session);
    (LoyaltySpin.findOne as jest.Mock).mockResolvedValue(null);
    const ready = await service.attachWs('ls_1', {
      send: jest.fn(),
      close: jest.fn(),
      readyState: 1
    });
    expect(session.status).toBe('READY');
    expect(ready.deviceId).toBe('DEVICE-17');
  });

  it('stays dormant on start when Mongo has no unfinished loyalty work', async () => {
    const { service } = makeService();
    await service.start();
    expect(service.isSweeping()).toBe(false);
    expect(LoyaltySpin.exists).toHaveBeenCalled();
    expect(LoyaltySession.exists).toHaveBeenCalled();
    expect(LoyaltySpin.find).not.toHaveBeenCalled();
  });

  it('recovers and arms sweep timers when boot finds leftover work', async () => {
    const { service } = makeService();
    (LoyaltySpin.exists as jest.Mock).mockResolvedValue({ _id: 'spin' });
    await service.start();
    expect(LoyaltySpin.find).toHaveBeenCalled();
    expect(service.isSweeping()).toBe(true);
  });

  it('join while dormant arms sweep timers', async () => {
    const { service } = makeService();
    await service.start();
    expect(service.isSweeping()).toBe(false);
    await service.join('DEVICE-17');
    expect(service.isSweeping()).toBe(true);
  });

  it('stops the service when a mutating sweep leaves no unfinished work', async () => {
    const onIdle = jest.fn();
    const { service } = makeService({ onIdle });
    (LoyaltySpin.exists as jest.Mock).mockResolvedValue({ _id: 'spin' });
    await service.start();
    expect(service.isSweeping()).toBe(true);

    const stale = spinDoc({
      status: 'COMMAND_PUBLISHED',
      commandPublishedAt: new Date(Date.now() - 10_000)
    });
    (LoyaltySpin.find as jest.Mock).mockResolvedValueOnce([stale]).mockResolvedValueOnce([]);
    (LoyaltySpin.exists as jest.Mock).mockResolvedValue(null);
    (LoyaltySession.exists as jest.Mock).mockResolvedValue(null);

    await service.sweepAckTimeouts();
    expect(service.isSweeping()).toBe(false);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('keeps sweep timers when work is created during exists check', async () => {
    const { service } = makeService();
    (LoyaltySpin.exists as jest.Mock).mockResolvedValue({ _id: 'spin' });
    await service.start();
    expect(service.isSweeping()).toBe(true);

    let releaseExists: (value: null) => void = () => undefined;
    const existsGate = new Promise<null>((resolve) => {
      releaseExists = resolve;
    });
    let sawExists: () => void = () => undefined;
    const existsStarted = new Promise<void>((resolve) => {
      sawExists = resolve;
    });
    (LoyaltySpin.exists as jest.Mock).mockImplementation(() => {
      sawExists();
      return existsGate;
    });
    (LoyaltySession.exists as jest.Mock).mockResolvedValue(null);

    const stale = spinDoc({
      status: 'COMMAND_PUBLISHED',
      commandPublishedAt: new Date(Date.now() - 10_000)
    });
    (LoyaltySpin.find as jest.Mock).mockResolvedValueOnce([stale]).mockResolvedValueOnce([]);

    const sweepDone = service.sweepAckTimeouts();
    await existsStarted;
    await service.join('DEVICE-17');
    releaseExists(null);
    await sweepDone;
    expect(service.isSweeping()).toBe(true);
  });
});
