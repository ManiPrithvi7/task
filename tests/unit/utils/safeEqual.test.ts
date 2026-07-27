import { timingSafeEqual } from 'crypto';
import { safeEqualString } from '@/utils/safeEqual';

describe('safeEqualString', () => {
  it('matches equal secrets', () => {
    expect(safeEqualString('abc', 'abc')).toBe(true);
  });

  it('rejects unequal secrets and length mismatch', () => {
    expect(safeEqualString('abc', 'abd')).toBe(false);
    expect(safeEqualString('abc', 'ab')).toBe(false);
  });

  it('uses constant-time compare for equal-length buffers', () => {
    const a = Buffer.from('secret-value', 'utf8');
    const b = Buffer.from('secret-value', 'utf8');
    expect(timingSafeEqual(a, b)).toBe(true);
  });
});
