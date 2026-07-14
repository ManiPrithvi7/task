/**
 * Resume + ceiling math for stimulate ramps.
 * Unit-tested (T001–T008).
 */

export function calcResume(liveCount: number, lastPublished: number, step: number): number {
  const resume = Math.max(liveCount, lastPublished + step);
  return resume;
}

export function ceilingSequence(resume: number, target: number): number {
  return Math.min(resume, target);
}

export function isAtOrPastTarget(liveCount: number, target: number): boolean {
  return liveCount >= target;
}

export function gmbCelebration(current: number): 'true' | 'false' {
  return current === 50 || current === 100 ? 'true' : 'false';
}
