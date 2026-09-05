import { StatsMqttLite } from './app';
import { logger } from './utils/logger';
import { getInstagramPollingMetricsSnapshot } from './services/instagramService';
import { getRedisService } from './services/redisService';
import { getActivityCounters } from './utils/activityMetrics';
import { startLeakHunter, stopLeakHunter } from './utils/leakHunter';

const app = new StatsMqttLite();
let shuttingDown = false;
let memoryLogTimer: ReturnType<typeof setInterval> | null = null;

function logMemoryUsage(): void {
  const m = process.memoryUsage();
  const ig = getInstagramPollingMetricsSnapshot();
  logger.info('memory_usage', {
    memory: {
      rss: `${(m.rss / 1024 / 1024).toFixed(2)} MB`,
      heapTotal: `${(m.heapTotal / 1024 / 1024).toFixed(2)} MB`,
      heapUsed: `${(m.heapUsed / 1024 / 1024).toFixed(2)} MB`,
      external: `${(m.external / 1024 / 1024).toFixed(2)} MB`,
      arrayBuffers: `${(m.arrayBuffers / 1024 / 1024).toFixed(2)} MB`
    },
    metrics: {
      ...getActivityCounters(),
      redisOperations: getRedisService()?.getCommandStats().total ?? 0,
      fetchesEnqueued: Number(ig.fetchesEnqueued ?? 0),
      fetchesSucceeded: Number(ig.fetchesSucceeded ?? 0),
      fetchesFailed: Number(ig.fetchesFailed ?? 0),
      fetchesNoCredentials: Number(ig.fetchesNoCredentials ?? 0)
    }
  });
}

app.start()
  .then(() => {
    startLeakHunter(() => app.leakSnapshot());
    logMemoryUsage();
    memoryLogTimer = setInterval(logMemoryUsage, 60_000);
    memoryLogTimer.unref?.();
  })
  .catch((error) => {
    logger.error('Fatal error during startup', {
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  });

const shutdown = async (signal: string) => {
  if (shuttingDown) {
    logger.warn(`Received ${signal} again — forcing exit`);
    process.exit(1);
  }
  shuttingDown = true;

  logger.info(`Received ${signal}, shutting down gracefully...`);

  const forceTimer = setTimeout(() => {
    logger.error('Shutdown timed out — forcing exit');
    process.exit(1);
  }, 30_000);
  forceTimer.unref();

  try {
    if (memoryLogTimer) {
      clearInterval(memoryLogTimer);
      memoryLogTimer = null;
    }
    stopLeakHunter();
    await app.stop();
    clearTimeout(forceTimer);
    process.exit(0);
  } catch (error: unknown) {
    clearTimeout(forceTimer);
    logger.error('Error during shutdown', {
      error: error instanceof Error ? error.message : String(error)
    });
    process.exit(1);
  }
};

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

// Handle unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Promise Rejection', { 
    reason,
    promise 
  });
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', { 
    error: error.message,
    stack: error.stack 
  });
  process.exit(1);
});
