import { processRollouts } from '@/jobs/rolloutScheduler';
import { FirmwareRelease } from '@/models/FirmwareRelease';

jest.mock('@/models/FirmwareRelease', () => ({
  FirmwareRelease: {
    find: jest.fn()
  },
  FirmwareReleaseStatus: { STABLE: 'stable' }
}));

jest.mock('@/notifications/slackOta', () => ({
  sendOtaSlackAlert: jest.fn().mockResolvedValue(false)
}));

describe('processRollouts', () => {
  const otaConfig = {
    stageAbortMinSample: 20,
    stageAbortFailureRate: 0.01,
    stageMinHours: 24
  } as never;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('aborts when failure rate exceeds threshold', async () => {
    (FirmwareRelease.find as jest.Mock).mockResolvedValue([
      {
        version: '2.3.0',
        aborted: false,
        currentPercentage: 10,
        stageAttemptedCount: 25,
        stageFailedCount: 3,
        stageRolledBackCount: 0,
        stageStartedAt: new Date(Date.now() - 25 * 3600_000)
      }
    ]);
    const abortRollout = jest.fn().mockResolvedValue({ ok: true });
    const advanceRollout = jest.fn();
    await processRollouts({ abortRollout, advanceRollout } as never, otaConfig);
    expect(abortRollout).toHaveBeenCalledWith('2.3.0', 'failure_rate');
    expect(advanceRollout).not.toHaveBeenCalled();
  });

  it('advances when healthy and 24h elapsed', async () => {
    (FirmwareRelease.find as jest.Mock).mockResolvedValue([
      {
        version: '2.3.0',
        aborted: false,
        currentPercentage: 1,
        stageAttemptedCount: 25,
        stageFailedCount: 0,
        stageRolledBackCount: 0,
        stageStartedAt: new Date(Date.now() - 25 * 3600_000)
      }
    ]);
    const abortRollout = jest.fn();
    const advanceRollout = jest.fn().mockResolvedValue({ ok: true });
    await processRollouts({ abortRollout, advanceRollout } as never, otaConfig);
    expect(advanceRollout).toHaveBeenCalledWith('2.3.0');
    expect(abortRollout).not.toHaveBeenCalled();
  });
});
