import { isAllowedLoyaltyOrigin } from '@/utils/loyaltyOrigin';

describe('isAllowedLoyaltyOrigin', () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  it('allows withproof.io and subdomains', () => {
    expect(isAllowedLoyaltyOrigin('https://withproof.io')).toBe(true);
    expect(isAllowedLoyaltyOrigin('https://app.withproof.io')).toBe(true);
  });

  it('does not allow arbitrary vercel.app hosts', () => {
    delete process.env.LOYALTY_PREVIEW_ORIGIN_PATTERN;
    expect(isAllowedLoyaltyOrigin('https://evil.vercel.app')).toBe(false);
  });

  it('allows CORS_ALLOWED_ORIGINS and preview regex', () => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://app.withproof.io';
    process.env.LOYALTY_PREVIEW_ORIGIN_PATTERN = '^https://statsnapp-[a-z0-9-]+\\.vercel\\.app$';
    expect(isAllowedLoyaltyOrigin('https://app.withproof.io')).toBe(true);
    expect(isAllowedLoyaltyOrigin('https://statsnapp-abc123.vercel.app')).toBe(true);
    expect(isAllowedLoyaltyOrigin('https://other-app.vercel.app')).toBe(false);
  });

  it('anchors unanchored preview patterns so query-string origins fail', () => {
    process.env.LOYALTY_PREVIEW_ORIGIN_PATTERN = 'https://statsnapp-.*\\.vercel\\.app';
    expect(isAllowedLoyaltyOrigin('https://statsnapp-abc.vercel.app')).toBe(true);
    expect(isAllowedLoyaltyOrigin('https://evil.com/?x=https://statsnapp-abc.vercel.app')).toBe(false);
  });

  it('allows loopback Origins so local Next.js WebSocket upgrades succeed', () => {
    expect(isAllowedLoyaltyOrigin('http://localhost:3000')).toBe(true);
    expect(isAllowedLoyaltyOrigin('http://127.0.0.1:3000')).toBe(true);
  });

  it('allows RFC1918 Origins in development for phone/LAN Next.js', () => {
    process.env.NODE_ENV = 'development';
    expect(isAllowedLoyaltyOrigin('http://10.106.98.236:3000')).toBe(true);
    expect(isAllowedLoyaltyOrigin('http://192.168.1.10:3000')).toBe(true);
  });

  it('does not allow RFC1918 Origins in production unless CORS listed', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.CORS_ALLOWED_ORIGINS;
    expect(isAllowedLoyaltyOrigin('http://10.106.98.236:3000')).toBe(false);
    process.env.CORS_ALLOWED_ORIGINS = 'http://10.106.98.236:3000';
    expect(isAllowedLoyaltyOrigin('http://10.106.98.236:3000')).toBe(true);
  });
});
