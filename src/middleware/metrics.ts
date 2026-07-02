import { Request, Response, NextFunction } from 'express';
import client from 'prom-client';

const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status'],
  registers: [register]
});

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration',
  labelNames: ['method', 'route'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [register]
});

export function metricsMiddleware(req: Request, res: Response, next: NextFunction) {
  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {
    const route = req.route?.path || req.path;
    httpRequestsTotal.inc({ method: req.method, route, status: res.statusCode.toString() });
    end({ method: req.method, route });
  });
  next();
}

export async function metricsHandler(req: Request, res: Response) {
  const internalSecret = process.env.INTERNAL_HEALTH_SECRET;
  const ip = req.ip || req.socket.remoteAddress || '';
  const isLoopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);
  const isInternal =
    isLoopback || (Boolean(internalSecret) && req.headers['x-internal-health'] === internalSecret);
  if (!isInternal) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  res.setHeader('Content-Type', register.contentType);
  res.send(await register.metrics());
}
