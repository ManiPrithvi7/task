import express from 'express';
import request from 'supertest';
import { createConfigRoutes } from '@/routes/configRoutes';
import type { ConfigRoutesDeps } from '@/routes/configRoutes';
import type { AppConfig } from '@/config';

function buildConfigRoutesApp(deps?: Partial<ConfigRoutesDeps>) {
  const app = express();
  const baseDeps: ConfigRoutesDeps = {
    config: {
      mqtt: { broker: 'mqtt.example.com', port: 8883 }
    } as AppConfig,
    caService: {
      getRootCACertificate: jest.fn().mockReturnValue('-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----')
    } as unknown as ConfigRoutesDeps['caService'],
    ...deps
  };
  app.use('/api/v1', createConfigRoutes(baseDeps));
  return app;
}

describe('configRoutes', () => {
  it('returns broker config and base64 CA cert', async () => {
    const res = await request(buildConfigRoutesApp())
      .get('/api/v1/mqtt-config')
      .expect(200);

    expect(res.body.broker).toBe('mqtt.example.com');
    expect(res.body.port).toBe(8883);
    expect(res.body.ca_cert).toBe(
      Buffer.from('-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----', 'utf8').toString('base64')
    );
  });

  it('returns null CA cert when caService is unavailable', async () => {
    const res = await request(buildConfigRoutesApp({ caService: undefined }))
      .get('/api/v1/mqtt-config')
      .expect(200);

    expect(res.body.ca_cert).toBeNull();
  });

  it('returns null CA cert when CA lookup throws', async () => {
    const res = await request(
      buildConfigRoutesApp({
        caService: {
          getRootCACertificate: jest.fn().mockImplementation(() => {
            throw new Error('CA unavailable');
          })
        } as unknown as ConfigRoutesDeps['caService']
      })
    )
      .get('/api/v1/mqtt-config')
      .expect(200);

    expect(res.body.ca_cert).toBeNull();
  });
});
