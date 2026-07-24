import request from 'supertest';
import { createE2eApp } from './helpers/buildTestApp';
import { createConnectionsRoutes } from '@/routes/connectionsRoutes';

jest.mock('@/config/connectionsConfig', () => ({
  resolveConnectionsValidateApiKey: () => 'e2e-connections-key'
}));

describe('E2E connections validate smoke', () => {
  it('returns 200 for canvas.updated with valid API key', async () => {
    const app = createE2eApp();
    app.use(
      '/api/v1',
      createConnectionsRoutes({
        statsPublisher: { publishPromotionForDevice: jest.fn() } as never,
        topicRoot: 'proof.mqtt'
      })
    );

    const res = await request(app)
      .post('/api/v1/connections/validate')
      .set('x-api-key', 'e2e-connections-key')
      .send({ userId: '674a1b2c3d4e5f678901234', event: 'canvas.updated' })
      .expect(200);

    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
  });
});
