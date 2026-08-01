import { WebhookLatencyTracker } from '@/services/webhookMetrics';
import { logger } from '@/utils/logger';

jest.mock('@/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));

describe('WebhookLatencyTracker', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reports near-zero stage timings when no marks and finish immediately', () => {
    const tracker = new WebhookLatencyTracker();
    tracker.finish('gmb', { deviceId: 'd1', topic: 't', dedupeHit: false });
    expect(logger.info).toHaveBeenCalledWith('webhook_latency', {
      provider: 'gmb',
      verifyMs: expect.any(Number),
      resolveMs: 0,
      publishMs: 0,
      totalMs: expect.any(Number),
      deviceId: 'd1',
      topic: 't',
      dedupeHit: false
    });
  });

  it('computes stage deltas from monotonic hrtime samples', () => {
    const spy = jest.spyOn(process.hrtime, 'bigint');
    // t0, verify, resolve, publish, finish
    spy
      .mockReturnValueOnce(1_000_000n) // ctor t0
      .mockReturnValueOnce(11_000_000n) // markVerified
      .mockReturnValueOnce(21_000_000n) // markResolved
      .mockReturnValueOnce(26_000_000n) // markPublished
      .mockReturnValueOnce(36_000_000n); // finish

    const tracker = new WebhookLatencyTracker();
    tracker.markVerified();
    tracker.markResolved();
    tracker.markPublished();
    tracker.finish('gmb', { skippedPublish: false });

    expect(logger.info).toHaveBeenCalledWith('webhook_latency', {
      provider: 'gmb',
      verifyMs: 10,
      resolveMs: 10,
      publishMs: 5,
      totalMs: 35,
      skippedPublish: false
    });
  });

  it('marks are optional and can be skipped entirely', () => {
    const spy = jest.spyOn(process.hrtime, 'bigint');
    spy
      .mockReturnValueOnce(0n)
      .mockReturnValueOnce(5_000_000n); // finish
    const tracker = new WebhookLatencyTracker();
    tracker.finish('gmb', {});
    expect(logger.info).toHaveBeenCalledWith('webhook_latency', expect.objectContaining({
      provider: 'gmb',
      verifyMs: 0,
      resolveMs: 0,
      publishMs: 0,
      totalMs: 5
    }));
  });
});
