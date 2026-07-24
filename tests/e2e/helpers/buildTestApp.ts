import express from 'express';

/** Minimal Express app wrapper for E2E HTTP flow tests. */
export function createE2eApp(): express.Express {
  const app = express();
  app.set('trust proxy', 1);
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'protocol', { value: 'https', configurable: true });
    next();
  });
  app.use(express.json({ limit: '512kb' }));
  return app;
}

export const TEST_USER_ID = '507f1f77bcf86cd799439011';
export const TEST_DEVICE_ID = 'device-e2e-1';
