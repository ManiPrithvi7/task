/**
 * OTA fleet rollout scheduler — recursive setTimeout, Redis lock, auto-advance/abort.
 */

import {
  FirmwareRelease,
  FirmwareReleaseStatus
} from '../models/FirmwareRelease';
import type { OtaService, OtaRedisState } from '../services/otaService';
import type { OtaConfig } from '../config';
import {
  OTA_SCHEDULER_INTERVAL_MS,
  OTA_SCHEDULER_LOCK_TTL_SEC,
  OTA_SCHEDULER_STALE_MS
} from '../config/otaDefaults';
import { canAdvanceStage, shouldAbortStage } from '../utils/otaRollout';
import { sendOtaSlackAlert } from '../notifications/slackOta';
import { logger } from '../utils/logger';

export type RolloutSchedulerHandle = {
  stop: () => void;
};

export function startRolloutScheduler(deps: {
  otaService: OtaService;
  otaRedisState: OtaRedisState;
  otaConfig: OtaConfig;
  intervalMs?: number;
}): RolloutSchedulerHandle {
  const intervalMs = deps.intervalMs ?? OTA_SCHEDULER_INTERVAL_MS;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const scheduleNext = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      void runOnce().finally(scheduleNext);
    }, intervalMs);
  };

  async function runOnce(): Promise<void> {
    const redis = deps.otaRedisState;
    const locked = await redis.tryAcquireSchedulerLock(OTA_SCHEDULER_LOCK_TTL_SEC);

    try {
      if (locked) {
        try {
          await processRollouts(deps.otaService, deps.otaConfig);
          await redis.markSchedulerRun(new Date());
        } catch (err: unknown) {
          logger.error('[OTA] rolloutScheduler processRollouts failed', {
            error: err instanceof Error ? err.message : String(err)
          });
        } finally {
          await redis.releaseSchedulerLock();
        }
      }

      await checkSchedulerHeartbeat(redis);
    } catch (err: unknown) {
      logger.warn('[OTA] rolloutScheduler tick failed', {
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  // Immediate catch-up, then schedule
  void runOnce().finally(scheduleNext);

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    }
  };
}

export async function processRollouts(
  otaService: OtaService,
  otaConfig: OtaConfig
): Promise<void> {
  const releases = await FirmwareRelease.find({
    status: FirmwareReleaseStatus.STABLE,
    aborted: { $ne: true },
    currentPercentage: { $lt: 100 }
  });

  for (const r of releases) {
    const attempted = r.stageAttemptedCount || 0;
    const failed = r.stageFailedCount || 0;
    const rolledBack = r.stageRolledBackCount || 0;
    const currentPercentage = r.currentPercentage ?? r.rollout?.percentage ?? 0;

    if (
      shouldAbortStage(
        attempted,
        failed,
        rolledBack,
        otaConfig.stageAbortMinSample,
        otaConfig.stageAbortFailureRate
      )
    ) {
      await otaService.abortRollout(r.version, 'failure_rate');
      continue;
    }

    if (
      canAdvanceStage({
        aborted: Boolean(r.aborted),
        currentPercentage,
        stageStartedAt: r.stageStartedAt,
        attempted,
        failed,
        rolledBack,
        minHours: otaConfig.stageMinHours,
        minSample: otaConfig.stageAbortMinSample,
        maxFailureRate: otaConfig.stageAbortFailureRate
      })
    ) {
      await otaService.advanceRollout(r.version);
      continue;
    }

    const stageAgeHours = r.stageStartedAt
      ? (Date.now() - new Date(r.stageStartedAt).getTime()) / 3_600_000
      : 0;

    if (stageAgeHours >= otaConfig.stageMinHours && attempted < otaConfig.stageAbortMinSample) {
      void sendOtaSlackAlert({
        kind: 'stuck',
        version: r.version,
        percentage: currentPercentage,
        attempted
      }).catch(() => undefined);
    }
  }
}

async function checkSchedulerHeartbeat(redis: OtaRedisState): Promise<void> {
  const last = await redis.getSchedulerLastRun();
  if (!last) return;
  const age = Date.now() - last.getTime();
  if (age > OTA_SCHEDULER_STALE_MS) {
    void sendOtaSlackAlert({
      kind: 'scheduler_dead',
      message: `last_run=${last.toISOString()} age_ms=${age}`
    }).catch(() => undefined);
  }
}
