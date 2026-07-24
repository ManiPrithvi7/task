import { logger } from '../utils/logger';
import { envInt } from './envHelpers';

export interface InstagramServerlessConfig {
  fetchUrl: string;
  apiKey?: string;
  timeoutMs: number;
}

export interface InstagramPollingConfig {
  priorityIntervalMs: number;
  backgroundIntervalMs: number;
  priorityTtlMs: number;
  batchSize: number;
  backoffThreshold: number;
  backoffWindowMs: number;
  priorityCapPerCycle: number;
  priorityZsetMaxMembers: number;
  priorityRefreshMaxDeltaMs: number;
  priorityAbsoluteMaxFutureMs: number;
  backgroundCapPerCycle: number;
  backgroundFairRotate: boolean;
  globalFetchBudgetPerMinute: number;
  fetchDedupeWindowMs: number;
  /** Use in-process circuit gate instead of Redis (rollback: set false). */
  useLocalCircuit: boolean;
  useLocalBackoff: boolean;
  useLocalBudget: boolean;
  useLocalDedupe: boolean;
  useLocalFairOffset: boolean;
}

export function loadInstagramServerlessConfig(): InstagramServerlessConfig {
  return {
    fetchUrl: process.env.INSTAGRAM_SERVERLESS_URL?.trim() || process.env.VERCEL_INSTAGRAM_FETCH_URL?.trim() || '',
    apiKey:
      process.env.INSTAGRAM_SERVERLESS_API_KEY?.trim() ||
      process.env.VERCEL_INSTAGRAM_FETCH_API_KEY?.trim() ||
      undefined,
    timeoutMs: parseInt(process.env.INSTAGRAM_SERVERLESS_TIMEOUT_MS || '30000', 10)
  };
}

export function loadInstagramPollingConfig(): InstagramPollingConfig {
  const instagramPolling: InstagramPollingConfig = {
    priorityIntervalMs: parseInt(process.env.IG_POLL_PRIORITY_INTERVAL_MS || '15000', 10),
    backgroundIntervalMs: parseInt(process.env.IG_POLL_BACKGROUND_INTERVAL_MS || '90000', 10),
    priorityTtlMs: parseInt(process.env.IG_POLL_PRIORITY_TTL_MS || '120000', 10),
    batchSize: envInt('IG_POLL_BATCH_SIZE', 50, ['BATCH_SIZE']),
    backoffThreshold: parseInt(process.env.IG_POLL_BACKOFF_THRESHOLD || '6', 10),
    backoffWindowMs: parseInt(process.env.IG_POLL_BACKOFF_WINDOW_MS || '60000', 10),
    priorityCapPerCycle: parseInt(process.env.IG_POLL_PRIORITY_CAP_PER_CYCLE || '0', 10),
    priorityZsetMaxMembers: parseInt(process.env.IG_POLL_PRIORITY_ZSET_MAX_MEMBERS || '0', 10),
    priorityRefreshMaxDeltaMs: parseInt(process.env.IG_POLL_PRIORITY_REFRESH_MAX_DELTA_MS || '0', 10),
    priorityAbsoluteMaxFutureMs: parseInt(process.env.IG_POLL_PRIORITY_MAX_FUTURE_MS || '0', 10),
    backgroundCapPerCycle: parseInt(process.env.IG_POLL_BACKGROUND_CAP_PER_CYCLE || '0', 10),
    backgroundFairRotate: process.env.IG_POLL_BACKGROUND_FAIR_ROTATE === 'false' ? false : true,
    globalFetchBudgetPerMinute: parseInt(process.env.IG_GLOBAL_FETCH_BUDGET_PER_MIN || '0', 10),
    fetchDedupeWindowMs: parseInt(process.env.IG_FETCH_DEDUPE_WINDOW_MS || '45000', 10),
    useLocalCircuit: process.env.IG_USE_LOCAL_CIRCUIT !== 'false',
    useLocalBackoff: process.env.IG_USE_LOCAL_BACKOFF !== 'false',
    useLocalBudget: process.env.IG_USE_LOCAL_BUDGET !== 'false',
    useLocalDedupe: process.env.IG_USE_LOCAL_DEDUPE !== 'false',
    useLocalFairOffset: process.env.IG_USE_LOCAL_FAIR_OFFSET !== 'false'
  };

  const bgMultRaw = process.env.IG_POLL_BACKGROUND_INTERVAL_MULTIPLIER_LOW_POWER?.trim();
  if (bgMultRaw) {
    const bgMult = parseFloat(bgMultRaw);
    if (bgMult > 1 && Number.isFinite(bgMult)) {
      instagramPolling.backgroundIntervalMs = Math.round(instagramPolling.backgroundIntervalMs * bgMult);
      logger.info('IG_POLL_BACKGROUND_INTERVAL_MULTIPLIER_LOW_POWER applied to background interval', {
        multiplier: bgMult,
        backgroundIntervalMs: instagramPolling.backgroundIntervalMs
      });
    }
  }

  return instagramPolling;
}
