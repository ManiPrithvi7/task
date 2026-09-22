import { StatsMqttLite } from './app';
import { logger } from './utils/logger';
import { getInstagramPollingMetricsSnapshot } from './services/instagramService';
import { getRedisService } from './services/redisService';
import { emitMemoryUsage, startMemoryUsageLogger, stopMemoryUsageLogger } from './utils/memoryUsageLogger';

const app = new StatsMqttLite();
let shuttingDown = false;

function logMemoryUsage(): Promise<void> {
  const ig = getInstagramPollingMetricsSnapshot();
  return emitMemoryUsage({
    mqttMessages: 0,
    publishes: 0,
    databaseQueries: 0,
    httpRequests: 0,
    redisOperations: getRedisService()?.getCommandStats().total ?? 0,
    fetchesEnqueued: Number(ig.fetchesEnqueued ?? 0),
    fetchesSucceeded: Number(ig.fetchesSucceeded ?? 0),
    fetchesFailed: Number(ig.fetchesFailed ?? 0),
    fetchesNoCredentials: Number(ig.fetchesNoCredentials ?? 0)
  });
}

app.start()
  .then(() => {
    startMemoryUsageLogger(logMemoryUsage);
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
    stopMemoryUsageLogger();
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
