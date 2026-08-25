import { notifyWebappFollowerUpdate } from '../../../src/services/webappFollowerWebhook';

jest.mock('../../../src/models/Social', () => ({
  Social: {
    findOne: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ _id: 'social123' })
      })
    })
  },
  Provider: { INSTAGRAM: 'INSTAGRAM' }
}));

describe('webappFollowerWebhook', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.WEBAPP_WEBHOOK_URL = 'https://app.example/api/internal/instagram/follower-update';
    process.env.WEBHOOK_SECRET = 'test-secret';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.WEBAPP_WEBHOOK_URL;
    delete process.env.WEBHOOK_SECRET;
  });

  it('does not POST when follower count unchanged', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    await notifyWebappFollowerUpdate({
      userId: '674a1b2c3d4e5f678901234',
      instagramAccountId: 'ig-acct',
      followerCount: 500,
      previousCount: 500,
      syncedAt: new Date('2026-08-01T00:00:00.000Z')
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs change payload with x-webhook-secret', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock as unknown as typeof fetch;

    await notifyWebappFollowerUpdate({
      userId: '507f1f77bcf86cd799439011',
      instagramAccountId: 'ig-acct',
      followerCount: 501,
      previousCount: 500,
      syncedAt: new Date('2026-08-01T00:00:00.000Z')
    });

    await new Promise((r) => setTimeout(r, 100));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(process.env.WEBAPP_WEBHOOK_URL);
    expect((init.headers as Record<string, string>)['x-webhook-secret']).toBe('test-secret');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      userId: '507f1f77bcf86cd799439011',
      socialId: 'social123',
      followerCount: 501,
      previousCount: 500
    });
  });
});
