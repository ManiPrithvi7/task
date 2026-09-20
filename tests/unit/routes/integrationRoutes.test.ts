import express from 'express';
import request from 'supertest';
import { createIntegrationRoutes } from '@/routes/integrationRoutes';
import { Provider } from '@/models/Social';

const mockVerify = jest.fn();
const mockApplyDisconnect = jest.fn();
const mockApplyConnect = jest.fn();
const mockOnStatusChanged = jest.fn();
const mockGetInflux = jest.fn();

jest.mock('@/services/influxService', () => ({
  getInfluxService: () => mockGetInflux()
}));

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1',
    createIntegrationRoutes({
      authService: { verifyAuthToken: mockVerify } as never,
      onStatusChanged: mockOnStatusChanged,
      applyDisconnectCache: mockApplyDisconnect,
      applyConnectCache: mockApplyConnect
    })
  );
  return app;
}

describe('POST /api/v1/integrations/connect disconnect', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVerify.mockResolvedValue({ valid: true, userId: 'aaaaaaaaaaaaaaaaaaaaaaaa' });
    mockApplyDisconnect.mockResolvedValue({
      deviceIds: ['d1', 'd2'],
      onlineDeviceIds: ['d1']
    });
    mockGetInflux.mockReturnValue({ writeProfileBaseline: jest.fn() });
  });

  it('returns 401 without bearer token', async () => {
    const res = await request(buildApp()).post('/api/v1/integrations/connect').send({
      provider: 'instagram',
      action: 'disconnect'
    });
    expect(res.status).toBe(401);
    expect(mockApplyDisconnect).not.toHaveBeenCalled();
  });

  it('returns 400 when provider is missing', async () => {
    const res = await request(buildApp())
      .post('/api/v1/integrations/connect')
      .set('Authorization', 'Bearer tok')
      .send({ action: 'disconnect' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('FIELDS_REQUIRED');
  });

  it('clears cache without Social/Influx and publishes for online devices', async () => {
    const res = await request(buildApp())
      .post('/api/v1/integrations/connect')
      .set('Authorization', 'Bearer tok')
      .send({ provider: 'instagram', action: 'disconnect' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, disconnected: true });
    expect(mockGetInflux).not.toHaveBeenCalled();
    expect(mockApplyDisconnect).toHaveBeenCalledWith({
      userId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      provider: Provider.INSTAGRAM,
      socialAccountId: undefined
    });
    expect(mockOnStatusChanged).toHaveBeenCalledTimes(1);
    expect(mockOnStatusChanged).toHaveBeenCalledWith('d1', {
      provider: Provider.INSTAGRAM,
      action: 'disconnect'
    });
    expect(mockApplyConnect).not.toHaveBeenCalled();
  });

  it('accepts connected:false without socialAccountId', async () => {
    const res = await request(buildApp())
      .post('/api/v1/integrations/connect')
      .set('Authorization', 'Bearer tok')
      .send({ provider: 'gmb', connected: false, socialAccountId: 'acc-1' });

    expect(res.status).toBe(200);
    expect(mockApplyDisconnect).toHaveBeenCalledWith({
      userId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      provider: Provider.GOOGLE_BUSINESS,
      socialAccountId: 'acc-1'
    });
  });

  it('accepts event social.disconnected', async () => {
    const res = await request(buildApp())
      .post('/api/v1/integrations/connect')
      .set('Authorization', 'Bearer tok')
      .send({ provider: 'INSTAGRAM', event: 'social.disconnected' });

    expect(res.status).toBe(200);
    expect(res.body.disconnected).toBe(true);
  });
});
