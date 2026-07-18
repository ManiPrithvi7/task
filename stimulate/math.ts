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

import { resolveCelebrationState } from '../src/services/screenEnvelope';

export function gmbCelebration(current: number): 'true' | 'false' {
  return resolveCelebrationState('gmb', current).celebration;
}

export function igCelebration(current: number): 'true' | 'false' {
  return resolveCelebrationState('instagram', current).celebration;
}
