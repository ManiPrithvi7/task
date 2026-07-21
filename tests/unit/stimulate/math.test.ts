/**
 * TEMP STIMULATE — remove after testing
 */
import {
  calcResume,
  ceilingSequence,
  isAtOrPastTarget,
  gmbCelebration,
  igCelebration
} from '../../../stimulate/math';

describe('calcResume (T001–T004)', () => {
  it('T001: live=10, lastPub=5, step=1 → resume=10 (live wins)', () => {
    expect(calcResume(10, 5, 1)).toBe(10);
  });

  it('T002: live=10, lastPub=15, step=1 → resume=16 (last+step wins)', () => {
    expect(calcResume(10, 15, 1)).toBe(16);
  });

  it('T003: live=0, lastPub=0, step=5 → resume=5', () => {
    expect(calcResume(0, 0, 5)).toBe(5);
  });

  it('T004: live=100, lastPub=97, step=2 → resume=100 (live wins)', () => {
    expect(calcResume(100, 97, 2)).toBe(100);
  });
});

describe('ceilingSequence (T005–T007)', () => {
  it('T005: resume=30, target=100 → 30 (below target)', () => {
    expect(ceilingSequence(30, 100)).toBe(30);
  });

  it('T006: resume=150, target=100 → 100 (capped at target)', () => {
    expect(ceilingSequence(150, 100)).toBe(100);
  });

  it('T007: resume=100, target=100 → 100 (at target)', () => {
    expect(ceilingSequence(100, 100)).toBe(100);
  });
});

describe('isAtOrPastTarget', () => {
  it('live below target → false', () => {
    expect(isAtOrPastTarget(50, 100)).toBe(false);
  });

  it('live at target → true', () => {
    expect(isAtOrPastTarget(100, 100)).toBe(true);
  });

  it('live past target → true', () => {
    expect(isAtOrPastTarget(200, 100)).toBe(true);
  });
});

describe('gmbCelebration (mini/5, mega/25)', () => {
  it('celebration at mini and mega boundaries', () => {
    expect(gmbCelebration(5)).toBe('true');
    expect(gmbCelebration(15)).toBe('true');
    expect(gmbCelebration(25)).toBe('true');
  });

  it('no celebration off-slab or at 0', () => {
    expect(gmbCelebration(0)).toBe('false');
    expect(gmbCelebration(4)).toBe('false');
    expect(gmbCelebration(11)).toBe('false');
  });
});

describe('igCelebration (mini/5, mega/25)', () => {
  it('celebration at mini and mega boundaries', () => {
    expect(igCelebration(5)).toBe('true');
    expect(igCelebration(10)).toBe('true');
    expect(igCelebration(25)).toBe('true');
  });

  it('no celebration off-slab or at 0', () => {
    expect(igCelebration(0)).toBe('false');
    expect(igCelebration(24)).toBe('false');
    expect(igCelebration(26)).toBe('false');
  });
});
