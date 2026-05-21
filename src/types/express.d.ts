import 'express';
import type { IncomingMessage } from 'http';

declare module 'http' {
  interface IncomingMessage {
    rawBody?: Buffer;
  }
}

declare global {
  namespace Express {
    interface Request {
      /** Raw request body bytes (webhook HMAC routes). */
      rawBody?: Buffer;
      deviceId?: string;
      mtls?: {
        cn?: string;
        fingerprint256?: string;
        slot?: 'primary' | 'staging';
      };
    }
  }
}

export {};

