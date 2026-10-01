import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import request from 'supertest';
import { createScreenLiveRoutes, formatScreenLiveSse } from '@/servers/screenLiveSse';
import { resetScreenLiveHubForTests } from '@/services/screenLiveHub';
import type { ScreenLiveSseDeps } from '@/servers/screenLiveSse';

const DEVICE = '274968B43A1D';

function buildApp(overrides: Partial<ScreenLiveSseDeps> = {}) {
  const app = express();
  app.use(
    '/screen',
    createScreenLiveRoutes({
      isBurstFinished: () => false,
      businessIdForDevice: async () => 'biz-1',
      followersForDevice: () => 5,
      reviewsForDevice: () => 2,
      authService: {
        verifyAuthToken: async () => ({ valid: true, userId: 'biz-1' })
      },
      ...overrides
    })
  );
  return app;
}

function listen(app: express.Express): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({
        port: addr.port,
        close: () =>
          new Promise((done, fail) => {
            server.close((err) => (err ? fail(err) : done()));
          })
      });
    });
  });
}

function readFirstEvent(port: number, path: string): Promise<{ status: number; contentType: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        hostname: '127.0.0.1',
        port,
        path,
        headers: { Origin: 'http://127.0.0.1:3000' }
      },
      (res) => {
        let body = '';
        const timer = setTimeout(() => {
          req.destroy();
          reject(new Error('timed out waiting for SSE event'));
        }, 2000);
        const finish = () => {
          clearTimeout(timer);
          res.destroy();
          req.destroy();
          resolve({
            status: res.statusCode || 0,
            contentType: String(res.headers['content-type'] || ''),
            body
          });
        };
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf8');
          if (body.includes('\n\n')) finish();
        });
        res.on('end', () => {
          if (!body.includes('\n\n')) finish();
        });
        res.on('error', (err) => {
          clearTimeout(timer);
          if (body.includes('\n\n')) return;
          reject(err);
        });
      }
    );
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNRESET') return;
      reject(err);
    });
  });
}

describe('screen live SSE', () => {
  const prevEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    resetScreenLiveHubForTests();
  });

  afterEach(() => {
    process.env.NODE_ENV = prevEnv;
    resetScreenLiveHubForTests();
  });

  it('frames hub JSON as a named SSE event', () => {
    const payload = JSON.stringify({
      event: 'screen.count',
      deviceId: DEVICE,
      followers: 42,
      at: '2026-10-01T00:00:00.000Z'
    });
    expect(formatScreenLiveSse(payload)).toBe(`event: screen.count\ndata: ${payload}\n\n`);
  });

  it('returns 403 JSON and does not open an event stream when the device is not allowlisted', async () => {
    const res = await request(buildApp())
      .get('/screen/realtime')
      .query({ deviceId: 'OTHER', token: 'user-jwt' });
    expect(res.status).toBe(403);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(String(res.headers['content-type'])).not.toMatch(/text\/event-stream/);
    expect(res.body).toEqual({ code: 'FORBIDDEN', message: 'device not allowlisted' });
  });

  it('returns 403 JSON when the burst has finished', async () => {
    const res = await request(buildApp({ isBurstFinished: () => true }))
      .get('/screen/realtime')
      .query({ deviceId: DEVICE, token: 'user-jwt' })
      .set('Origin', 'http://127.0.0.1:3000');
    expect(res.status).toBe(403);
    expect(String(res.headers['content-type'])).not.toMatch(/text\/event-stream/);
    expect(res.body.message).toBe('connect burst finished');
  });

  it('returns 403 JSON on a business mismatch', async () => {
    const res = await request(
      buildApp({
        authService: { verifyAuthToken: async () => ({ valid: true, userId: 'biz-1' }) },
        businessIdForDevice: async () => 'biz-2'
      })
    )
      .get('/screen/realtime')
      .query({ deviceId: DEVICE, token: 'user-jwt' })
      .set('Origin', 'http://127.0.0.1:3000');
    expect(res.status).toBe(403);
    expect(String(res.headers['content-type'])).not.toMatch(/text\/event-stream/);
    expect(res.body.message).toBe('business mismatch');
  });

  it('rejects a disallowed origin before opening the stream', async () => {
    const res = await request(buildApp())
      .get('/screen/realtime')
      .query({ deviceId: DEVICE, token: 'user-jwt' })
      .set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
    expect(String(res.headers['content-type'])).not.toMatch(/text\/event-stream/);
    expect(res.body.message).toBe('origin not allowed');
  });

  it('writes a screen.count snapshot on an open stream', async () => {
    const app = buildApp();
    const server = await listen(app);
    try {
      const frame = await readFirstEvent(
        server.port,
        `/screen/realtime?deviceId=${DEVICE}&token=user-jwt`
      );
      expect(frame.status).toBe(200);
      expect(frame.contentType).toMatch(/text\/event-stream/);
      expect(frame.body.startsWith('event: screen.count\n')).toBe(true);
      expect(frame.body).toContain('"followers":5');
      expect(frame.body).toContain('"reviews":2');
      expect(frame.body.endsWith('\n\n')).toBe(true);
    } finally {
      await server.close();
    }
  });
});
