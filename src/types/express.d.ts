import 'express';

declare global {
  namespace Express {
    interface Request {
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

