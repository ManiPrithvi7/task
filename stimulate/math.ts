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

/** Celebrate on every 5-review slab boundary (aligned with gmbReviewMetrics). */
export function gmbCelebration(current: number): 'true' | 'false' {
  return current > 0 && current % 5 === 0 ? 'true' : 'false';
}

/** Celebrate on every 25-follower slab boundary (aligned with instagramFollowerMetrics). */
export function igCelebration(current: number): 'true' | 'false' {
  return current > 0 && current % 25 === 0 ? 'true' : 'false';
}
