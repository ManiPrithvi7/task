import { describe, expect, it } from 'bun:test';
import { Provider } from '../../../src/models/Social';
import { parseConnectProvider, parseConnectAction } from '../../../src/utils/parseConnectProvider';

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

describe('parseConnectAction', () => {
  it('defaults to connect', () => {
    expect(parseConnectAction({})).toBe('connect');
    expect(parseConnectAction({ action: 'connect' })).toBe('connect');
    expect(parseConnectAction({ connected: true })).toBe('connect');
  });

  it('detects disconnect aliases', () => {
    expect(parseConnectAction({ action: 'disconnect' })).toBe('disconnect');
    expect(parseConnectAction({ action: 'DISCONNECTED' })).toBe('disconnect');
    expect(parseConnectAction({ connected: false })).toBe('disconnect');
    expect(parseConnectAction({ connected: 'false' })).toBe('disconnect');
    expect(parseConnectAction({ event: 'social.disconnected' })).toBe('disconnect');
  });
});
