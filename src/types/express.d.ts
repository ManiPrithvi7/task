import 'express';
import 'http';

declare module 'express-serve-static-core' {
  interface Request {
    correlationId?: string;
    deviceId?: string;
    rawBody?: Buffer;
  }
}

declare module 'http' {
  interface IncomingMessage {
    rawBody?: Buffer;
  }
}
