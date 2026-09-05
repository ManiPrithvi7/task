import { StatsMqttLite } from './app';
import { logger } from './utils/logger';
import { startLeakHunter, stopLeakHunter } from './utils/leakHunter';

const app = new StatsMqttLite();
let shuttingDown = false;

app.start()
  .then(() => {
    startLeakHunter(() => app.leakSnapshot());
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
