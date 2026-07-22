import { OtaEventHandler } from '@/services/otaService';

import { Device } from '@/models/Device';

jest.mock('@/services/influxService', () => ({
  getInfluxService: () => null
}));

jest.mock('@/services/auditService', () => ({
  AuditEventType: { OTA_SUCCESS: 'OTA_SUCCESS', OTA_ROLLBACK: 'OTA_ROLLBACK', OTA_DEVICE_STATE_CHANGED: 'OTA_DEVICE_STATE_CHANGED' },
  getAuditService: () => null
}));

jest.mock('@/models/Device', () => ({
  Device: {
    findOne: jest.fn()
  },
  DeviceOtaState: {
    DOWNLOADING: 'downloading',
    VALIDATING: 'validating',
    NOTIFIED: 'notified',
    ROLLBACK_REPORTED: 'rollback_reported',
    IDLE: 'idle'
  }
}));

describe('OtaEventHandler', () => {
  const recordOtaSuccess = jest.fn().mockResolvedValue(undefined);
  const markDeviceDelivered = jest.fn().mockResolvedValue(undefined);
  const recordOtaFailure = jest.fn().mockResolvedValue({ blocked: false, failures: 1 });
  const updateOtaState = jest.fn().mockResolvedValue(undefined);
  const publishRollbackAck = jest.fn().mockResolvedValue(undefined);
  const getActiveReleaseMeta = jest.fn().mockResolvedValue(null);

  const handler = new OtaEventHandler(
    {
      recordOtaSuccess,
      markDeviceDelivered,
      recordOtaFailure,
      updateOtaState,
      getActiveReleaseMeta
    } as never,
    { publishRollbackAck } as never
  );

  beforeEach(() => {
    jest.clearAllMocks();
    (Device.findOne as jest.Mock).mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          clientId: 'dev-1',
          firmwareVersion: '4.3.0',
          otaState: 'idle'
        })
      })
    });
  });

  it('records success and updates firmware version', async () => {
    await handler.handle('dev-1', { type: 'ota_success', version: '4.3.1' });
    expect(recordOtaSuccess).toHaveBeenCalledWith('dev-1', '4.3.1');
    expect(markDeviceDelivered).toHaveBeenCalledWith('dev-1', '4.3.1');
  });

  it('records pilot ota-fail with nested metadata', async () => {
    await handler.handle('dev-1', {
      type: 'ota-fail',
      metadata: {
        fw_version: '4.3.1-mvp',
        reason: 'health_check_failed'
      }
    });
    expect(recordOtaFailure).toHaveBeenCalledWith(
      'dev-1',
      '4.3.1-mvp',
      'health_check_failed'
    );
    expect(publishRollbackAck).not.toHaveBeenCalled();
  });

  it('publishes rollback ack on legacy ota_rollback', async () => {
    await handler.handle('dev-1', {
      type: 'ota_rollback',
      attempted_version: '4.3.1',
      reason: 'mqtt health failed'
    });
    expect(recordOtaFailure).toHaveBeenCalledWith(
      'dev-1',
      '4.3.1',
      'mqtt health failed'
    );
    expect(publishRollbackAck).toHaveBeenCalledWith('dev-1', '4.3.1');
  });

  it('ignores ota_progress in pilot mode', async () => {
    await handler.handle('dev-1', { event: 'ota_progress' });
    expect(updateOtaState).not.toHaveBeenCalled();
  });
});
