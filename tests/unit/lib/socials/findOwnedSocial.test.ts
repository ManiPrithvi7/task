import mongoose from 'mongoose';
import { Provider } from '@/models/Social';

const mockLeanFind = jest.fn();
const mockCollectionFindOne = jest.fn();

jest.mock('@/models/Social', () => ({
  Social: {
    findOne: (...args: unknown[]) => ({
      lean: () => mockLeanFind(...args),
      sort: () => ({ lean: () => mockLeanFind(...args) })
    }),
    collection: { findOne: (...args: unknown[]) => mockCollectionFindOne(...args) }
  },
  Provider: { INSTAGRAM: 'INSTAGRAM', GOOGLE_BUSINESS: 'GOOGLE_BUSINESS' }
}));

import { findOwnedSocial, socialOwnerId, businessOwnerMatch } from '@/lib/socials/findOwnedSocial';

const BUSINESS_ID = '6a912cb61c0192e41bd2f62a';
const ACCOUNT_ID = '17841404223549106';

describe('findOwnedSocial', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLeanFind.mockResolvedValue(null);
    mockCollectionFindOne.mockResolvedValue(null);
  });

  it('treats JWT userId as businessId and matches legacy userId field', async () => {
    mockLeanFind.mockResolvedValueOnce({
      _id: new mongoose.Types.ObjectId(),
      userId: BUSINESS_ID,
      socialAccountId: ACCOUNT_ID,
      provider: 'INSTAGRAM',
      accessToken: 'tok',
      refreshToken: 'ref',
      tokenExp: '1'
    });

    const result = await findOwnedSocial({
      businessId: BUSINESS_ID,
      socialAccountId: ACCOUNT_ID,
      provider: Provider.INSTAGRAM
    });

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(socialOwnerId(result.social, 'fallback')).toBe(BUSINESS_ID);
    }
    const filter = mockLeanFind.mock.calls[0][0] as { socialAccountId: string; provider: { $in: string[] } };
    expect(filter.socialAccountId).toBe(ACCOUNT_ID);
    expect(filter.provider.$in).toContain('INSTAGRAM');
  });

  it('matches businessId ObjectId or string on userId and businessId', () => {
    const clause = businessOwnerMatch(BUSINESS_ID);
    expect(clause.$or).toEqual(
      expect.arrayContaining([
        { businessId: BUSINESS_ID },
        { userId: BUSINESS_ID },
        { businessId: new mongoose.Types.ObjectId(BUSINESS_ID) },
        { userId: new mongoose.Types.ObjectId(BUSINESS_ID) }
      ])
    );
  });

  it('returns not_found when account belongs to a different business', async () => {
    mockLeanFind.mockResolvedValueOnce({
      socialAccountId: ACCOUNT_ID,
      userId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      provider: 'INSTAGRAM'
    });

    const result = await findOwnedSocial({
      businessId: BUSINESS_ID,
      socialAccountId: ACCOUNT_ID,
      provider: Provider.INSTAGRAM
    });
    expect(result.status).toBe('not_found');
  });

  it('returns not_found when no Social row exists', async () => {
    const result = await findOwnedSocial({
      businessId: BUSINESS_ID,
      socialAccountId: ACCOUNT_ID,
      provider: Provider.INSTAGRAM
    });
    expect(result.status).toBe('not_found');
  });

  it('socialOwnerId prefers businessId then legacy userId', () => {
    expect(socialOwnerId({ businessId: 'b1', userId: 'u1' }, 'fb')).toBe('b1');
    expect(socialOwnerId({ userId: BUSINESS_ID }, 'fb')).toBe(BUSINESS_ID);
    expect(socialOwnerId({}, 'fb')).toBe('fb');
  });
});
