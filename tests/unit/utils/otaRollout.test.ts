import {
  canAdvanceStage,
  classifyOtaReason,
  deviceHashBucket,
  nextRolloutPercentage,
  normalizeOtaReasonCode,
  shouldAbortStage,
  shouldIncrementFailed,
  shouldIncrementRolledBack
} from '@/utils/otaRollout';

describe('otaRollout helpers', () => {
  it('hashes DEVICE-13 to bucket 40', () => {
    expect(deviceHashBucket('DEVICE-13')).toBe(40);
  });

  it('normalizes hyphen and underscore reasons', () => {
    expect(normalizeOtaReasonCode('download-timeout')).toBe('download_timeout');
    expect(classifyOtaReason('download-timeout')).toBe('transient');
    expect(classifyOtaReason('flash_error')).toBe('permanent');
    expect(classifyOtaReason('track_mismatch')).toBe('track_mismatch');
  });

  it('maps health_check_failed to failed + rolled_back', () => {
    expect(shouldIncrementFailed('permanent', 'health_check_failed')).toBe(true);
    expect(shouldIncrementRolledBack('permanent', 'health_check_failed')).toBe(true);
    expect(shouldIncrementFailed('permanent', 'rollback')).toBe(false);
    expect(shouldIncrementRolledBack('permanent', 'rollback')).toBe(true);
  });

  it('enforces monotonic steps 1→10→50→100', () => {
    expect(nextRolloutPercentage(1)).toBe(10);
    expect(nextRolloutPercentage(10)).toBe(50);
    expect(nextRolloutPercentage(50)).toBe(100);
    expect(nextRolloutPercentage(100)).toBeNull();
  });

  it('aborts at 20 attempted with 1% failure', () => {
    expect(shouldAbortStage(19, 1, 0, 20, 0.01)).toBe(false);
    expect(shouldAbortStage(20, 1, 0, 20, 0.01)).toBe(true);
    expect(shouldAbortStage(25, 3, 0, 20, 0.01)).toBe(true);
  });

  it('can_advance requires 24h + sample + healthy', () => {
    const started = new Date(Date.now() - 25 * 3600_000);
    expect(
      canAdvanceStage({
        aborted: false,
        currentPercentage: 1,
        stageStartedAt: started,
        attempted: 20,
        failed: 0,
        rolledBack: 0,
        minHours: 24,
        minSample: 20,
        maxFailureRate: 0.01
      })
    ).toBe(true);

    expect(
      canAdvanceStage({
        aborted: false,
        currentPercentage: 1,
        stageStartedAt: new Date(Date.now() - 23 * 3600_000),
        attempted: 20,
        failed: 0,
        rolledBack: 0,
        minHours: 24,
        minSample: 20,
        maxFailureRate: 0.01
      })
    ).toBe(false);
  });
});
