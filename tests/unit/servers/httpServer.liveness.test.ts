import { AddressInfo } from 'net';
import { listenHttpLiveness } from '@/servers/httpServer';
import express from 'express';

describe('listenHttpLiveness', () => {
  it('serves GET /health before Express is attached, then delegates', async () => {
    const listener = await listenHttpLiveness(0, '127.0.0.1');
    const { port } = listener.server.address() as AddressInfo;

    try {
      const live = await fetch(`http://127.0.0.1:${port}/health`);
      expect(live.status).toBe(200);
      const liveBody = (await live.json()) as { status: string };
      expect(liveBody.status).toBe('ok');

      const starting = await fetch(`http://127.0.0.1:${port}/ready`);
      expect(starting.status).toBe(503);

      const app = express();
      app.get('/ready', (_req, res) => {
        res.json({ status: 'ready' });
      });
      listener.attachExpress(app);

      const ready = await fetch(`http://127.0.0.1:${port}/ready`);
      expect(ready.status).toBe(200);
      const readyBody = (await ready.json()) as { status: string };
      expect(readyBody.status).toBe('ready');
    } finally {
      await listener.close();
    }
  });
});
