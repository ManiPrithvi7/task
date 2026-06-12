import { OtaEventHandler } from '@/services/otaEventHandler';

jest.mock('@/services/auditService', () => ({
  AuditEventType: { OTA_SUCCESS: 'OTA_SUCCESS', OTA_ROLLBACK: 'OTA_ROLLBACK' },
  getAuditService: () => null
}));

describe('OtaEventHandler', () => {
  const recordOtaSuccess = jest.fn().mockResolvedValue(undefined);
  const recordRollbackFailure = jest.fn().mockResolvedValue({ blocked: false, failures: 1 });
  const updateOtaState = jest.fn().mockResolvedValue(undefined);
  const publishRollbackAck = jest.fn().mockResolvedValue(undefined);

  const handler = new OtaEventHandler(
    {
      recordOtaSuccess,
      recordRollbackFailure,
      updateOtaState
    } as never,
    { publishRollbackAck } as never
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('records success and updates firmware version', async () => {
    await handler.handle('dev-1', { type: 'ota_success', version: '4.3.1' });
    expect(recordOtaSuccess).toHaveBeenCalledWith('dev-1', '4.3.1');
  });

  it('publishes rollback ack on ota_rollback', async () => {
    await handler.handle('dev-1', {
      type: 'ota_rollback',
      attempted_version: '4.3.1',
      reason: 'mqtt health failed'
    });
    expect(recordRollbackFailure).toHaveBeenCalledWith(
      'dev-1',
      '4.3.1',
      'mqtt health failed'
    );
    expect(publishRollbackAck).toHaveBeenCalledWith('dev-1', '4.3.1');
  });

  it('updates state on ota_progress', async () => {
    await handler.handle('dev-1', { event: 'ota_progress' });
    expect(updateOtaState).toHaveBeenCalled();
  });
});
