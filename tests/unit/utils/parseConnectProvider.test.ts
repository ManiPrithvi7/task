import { describe, expect, it } from 'bun:test';
import { Provider } from '../../../src/models/Social';
import { parseConnectProvider } from '../../../src/utils/parseConnectProvider';

describe('parseConnectProvider', () => {
  it('accepts Next and Prisma Instagram aliases', () => {
    expect(parseConnectProvider('instagram')).toBe(Provider.INSTAGRAM);
    expect(parseConnectProvider('INSTAGRAM')).toBe(Provider.INSTAGRAM);
    expect(parseConnectProvider('ig')).toBe(Provider.INSTAGRAM);
  });

  it('accepts Next and Prisma GMB aliases', () => {
    expect(parseConnectProvider('gmb')).toBe(Provider.GOOGLE_BUSINESS);
    expect(parseConnectProvider('GOOGLE_BUSINESS')).toBe(Provider.GOOGLE_BUSINESS);
    expect(parseConnectProvider('google_business')).toBe(Provider.GOOGLE_BUSINESS);
    expect(parseConnectProvider('google-business')).toBe(Provider.GOOGLE_BUSINESS);
  });

  it('rejects unknown providers', () => {
    expect(parseConnectProvider('twitter')).toBeNull();
    expect(parseConnectProvider('')).toBeNull();
    expect(parseConnectProvider(undefined)).toBeNull();
  });
});
