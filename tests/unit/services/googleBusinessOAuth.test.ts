import { OAuth2Client } from 'google-auth-library';
import mongoose from 'mongoose';

const mockSetCredentials = jest.fn();
const mockRefreshAccessToken = jest.fn();

jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({
    setCredentials: mockSetCredentials,
    refreshAccessToken: mockRefreshAccessToken,
    request: jest.fn()
  }))
}));

const mockFindOne = jest.fn();
const mockUpdateOne = jest.fn();
jest.mock('@/models/Social', () => ({
  Social: {
    findOne: (...a: unknown[]) => ({ lean: () => mockFindOne(...a) }),
    updateOne: (...a: unknown[]) => mockUpdateOne(...a)
  },
  Provider: { GOOGLE_BUSINESS: 'GOOGLE_BUSINESS' }
}));

import {
  createGoogleBusinessOAuth2Client,
  getValidOAuth2Client
} from '@/services/googleBusiness/googleBusinessOAuth';
import { logger } from '@/utils/logger';

const OAuth2ClientMock = OAuth2Client as unknown as jest.Mock;
const TEST_USER_ID = '507f1f77bcf86cd799439011';

function webhookConfig(overrides: Record<string, unknown> = {}) {
  return {
    googleBusinessClientId: 'client-id',
    googleBusinessClientSecret: 'client-secret',
    publicBaseUrl: 'https://app.example.com/',
    ...overrides
  } as never;
}

function socialDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: 's1',
    accessToken: 'old-token',
    refreshToken: 'refresh-token',
    tokenExp: '3600',
    tokenCreatedAt: new Date(),
    ...overrides
  };
}

describe('googleBusinessOAuth', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GOOGLE_BUSINESS_REDIRECT_URI;
    mockRefreshAccessToken.mockResolvedValue({ credentials: { access_token: 'new-token', expiry_date: Date.now() + 3_600_000 } });
  });

  describe('createGoogleBusinessOAuth2Client', () => {
    it('returns null when client id or secret missing', () => {
      expect(createGoogleBusinessOAuth2Client(webhookConfig({ googleBusinessClientId: undefined }))).toBeNull();
      expect(createGoogleBusinessOAuth2Client(webhookConfig({ googleBusinessClientSecret: '' }))).toBeNull();
      expect(OAuth2ClientMock).not.toHaveBeenCalled();
    });

    it('builds redirect URI from GOOGLE_BUSINESS_REDIRECT_URI env', () => {
      process.env.GOOGLE_BUSINESS_REDIRECT_URI = 'https://cb.example.com/oauth';
      createGoogleBusinessOAuth2Client(webhookConfig());
      expect(OAuth2ClientMock).toHaveBeenCalledWith('client-id', 'client-secret', 'https://cb.example.com/oauth');
    });

    it('falls back to publicBaseUrl + path (strips trailing slash)', () => {
      createGoogleBusinessOAuth2Client(webhookConfig());
      expect(OAuth2ClientMock).toHaveBeenCalledWith('client-id', 'client-secret', 'https://app.example.com/api/social/google-business');
    });

    it('falls back to localhost default when no base url', () => {
      createGoogleBusinessOAuth2Client(webhookConfig({ publicBaseUrl: undefined }));
      expect(OAuth2ClientMock).toHaveBeenCalledWith('client-id', 'client-secret', 'http://localhost:3000/api/social/google-business');
    });
  });

  describe('getValidOAuth2Client', () => {
    it('returns null when no oauth client configured', async () => {
      const result = await getValidOAuth2Client(TEST_USER_ID, webhookConfig({ googleBusinessClientId: undefined }));
      expect(result).toBeNull();
      expect(mockFindOne).not.toHaveBeenCalled();
    });

    it('returns null when social doc not found', async () => {
      mockFindOne.mockResolvedValue(null);
      const result = await getValidOAuth2Client(TEST_USER_ID, webhookConfig());
      expect(result).toBeNull();
      expect(mockFindOne).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: new mongoose.Types.ObjectId(TEST_USER_ID),
          provider: 'GOOGLE_BUSINESS',
        })
      );
    });

    it('returns null when refreshToken missing', async () => {
      mockFindOne.mockResolvedValue(socialDoc({ refreshToken: '' }));
      expect(await getValidOAuth2Client(TEST_USER_ID, webhookConfig())).toBeNull();
      expect(mockRefreshAccessToken).not.toHaveBeenCalled();
    });

    it('returns cached token without refreshing when not expired', async () => {
      mockFindOne.mockResolvedValue(socialDoc());
      const client = await getValidOAuth2Client(TEST_USER_ID, webhookConfig());
      expect(client).not.toBeNull();
      expect(mockRefreshAccessToken).not.toHaveBeenCalled();
      expect(mockSetCredentials).toHaveBeenCalledWith({ access_token: 'old-token', refresh_token: 'refresh-token' });
    });

    it('refreshes expired token, persists updateOne, returns client with new token', async () => {
      mockFindOne.mockResolvedValue(socialDoc({ tokenCreatedAt: new Date(Date.now() - 4000 * 1000) }));
      const client = await getValidOAuth2Client(TEST_USER_ID, webhookConfig());
      expect(mockRefreshAccessToken).toHaveBeenCalled();
      expect(mockUpdateOne).toHaveBeenCalledWith(
        { _id: 's1' },
        expect.objectContaining({ accessToken: 'new-token', tokenCreatedAt: expect.any(Date) })
      );
      expect(client).not.toBeNull();
      expect(mockSetCredentials).toHaveBeenCalledWith({ access_token: 'new-token', refresh_token: 'refresh-token' });
    });

    it('returns null when refresh yields no access_token', async () => {
      mockFindOne.mockResolvedValue(socialDoc({ tokenCreatedAt: new Date(Date.now() - 4000 * 1000) }));
      mockRefreshAccessToken.mockResolvedValue({ credentials: {} });
      expect(await getValidOAuth2Client(TEST_USER_ID, webhookConfig())).toBeNull();
      expect(mockUpdateOne).not.toHaveBeenCalled();
    });

    it('returns null and warns on invalid_grant (message)', async () => {
      mockFindOne.mockResolvedValue(socialDoc({ tokenCreatedAt: new Date(Date.now() - 4000 * 1000) }));
      mockRefreshAccessToken.mockRejectedValue(new Error('Error: invalid_grant'));
      expect(await getValidOAuth2Client(TEST_USER_ID, webhookConfig())).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith('[GMB_OAUTH] invalid_grant — reconnect Google Business in app');
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('returns null and warns on invalid_grant (response data)', async () => {
      mockFindOne.mockResolvedValue(socialDoc({ tokenCreatedAt: new Date(Date.now() - 4000 * 1000) }));
      mockRefreshAccessToken.mockRejectedValue({ response: { data: { error: 'invalid_grant' } } });
      expect(await getValidOAuth2Client(TEST_USER_ID, webhookConfig())).toBeNull();
      expect(logger.warn).toHaveBeenCalled();
    });

    it('returns null and logs error on other refresh failures', async () => {
      mockFindOne.mockResolvedValue(socialDoc({ tokenCreatedAt: new Date(Date.now() - 4000 * 1000) }));
      mockRefreshAccessToken.mockRejectedValue(new Error('network down'));
      expect(await getValidOAuth2Client(TEST_USER_ID, webhookConfig())).toBeNull();
      expect(logger.error).toHaveBeenCalledWith('[GMB_OAUTH] refresh failed', expect.anything());
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });
});
