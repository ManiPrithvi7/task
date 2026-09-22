import { emitMemoryUsage, formatMemoryBlock, registerMemoryGauge, sampleDiag } from '@/utils/memoryUsageLogger';
import { logger } from '@/utils/logger';

describe('memoryUsageLogger', () => {
  it('formatMemoryBlock keeps dashboard string shape', () => {
    const block = formatMemoryBlock({
      rss: 1048576,
      heapTotal: 2097152,
      heapUsed: 3145728,
      external: 4194304,
      arrayBuffers: 5242880
    });
    expect(block).toEqual({
      rss: '1.00 MB',
      heapTotal: '2.00 MB',
      heapUsed: '3.00 MB',
      external: '4.00 MB',
      arrayBuffers: '5.00 MB'
    });
  });

  it('sampleDiag includes uptimeSec and registered gauges', async () => {
    registerMemoryGauge('mqttMsgListeners', () => 2);
    const diag = await sampleDiag();
    expect(typeof diag.uptimeSec).toBe('number');
    expect(diag.mqttMsgListeners).toBe(2);
    expect(typeof diag.rssMB).toBe('number');
    expect(typeof diag.heapMB).toBe('number');
  });

  it('emitMemoryUsage keeps memory/metrics siblings and adds diag', async () => {
    await emitMemoryUsage({
      mqttMessages: 0,
      publishes: 0,
      databaseQueries: 0,
      httpRequests: 0,
      redisOperations: 0,
      fetchesEnqueued: 0,
      fetchesSucceeded: 0,
      fetchesFailed: 0,
      fetchesNoCredentials: 0
    });
    expect(logger.info).toHaveBeenCalledWith(
      'memory_usage',
      expect.objectContaining({
        memory: expect.objectContaining({
          rss: expect.stringMatching(/ MB$/),
          heapTotal: expect.stringMatching(/ MB$/),
          heapUsed: expect.stringMatching(/ MB$/),
          external: expect.stringMatching(/ MB$/),
          arrayBuffers: expect.stringMatching(/ MB$/)
        }),
        metrics: expect.objectContaining({
          mqttMessages: 0,
          redisOperations: 0,
          fetchesEnqueued: 0
        }),
        diag: expect.objectContaining({
          uptimeSec: expect.any(Number)
        })
      })
    );
  });
});
