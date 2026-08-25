import type { InstagramFetchTrigger } from './instagramService';
import { logger } from '../utils/logger';

export type AccountFetchDecision =
  | { action: 'fetch' }
  | { action: 'cache_hit'; followersCount: number; username?: string; fetchedAtMs: number };

type HourlyBucket = { hourSlot: number; cron: number; onDemand: number; total: number };

export type AccountCachedFetch = {
  followersCount: number;
  username?: string;
  fetchedAtMs: number;
};

const FRESH_MS = 60_000;

function envInt(name: string, fallback: number): number {
  const n = parseInt(process.env[name] || String(fallback), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function isOnDemandTrigger(trigger: InstagramFetchTrigger): boolean {
  return trigger === 'connect' || trigger === 'attention';
}

class IgAccountFetchCoordinatorImpl {
  private readonly cache = new Map<string, AccountCachedFetch>();
  private readonly hourly = new Map<string, HourlyBucket>();
  private readonly backoffUntil = new Map<string, number>();
  private readonly cronCapPerHr = envInt('IG_ACCOUNT_CRON_CAP_PER_HR', 60);
  private readonly onDemandCapPerHr = envInt('IG_ACCOUNT_ON_DEMAND_CAP_PER_HR', 30);
  private readonly totalCapPerHr = envInt('IG_ACCOUNT_TOTAL_CAP_PER_HR', 200);

  private hourSlot(nowMs = Date.now()): number {
    return Math.floor(nowMs / 3_600_000);
  }

  private bucket(igAccountId: string, nowMs = Date.now()): HourlyBucket {
    const slot = this.hourSlot(nowMs);
    const existing = this.hourly.get(igAccountId);
    if (existing && existing.hourSlot === slot) return existing;
    const next = { hourSlot: slot, cron: 0, onDemand: 0, total: 0 };
    this.hourly.set(igAccountId, next);
    return next;
  }

  getCached(igAccountId: string): AccountCachedFetch | null {
    return this.cache.get(igAccountId) ?? null;
  }

  decideFetch(igAccountId: string, trigger: InstagramFetchTrigger): AccountFetchDecision {
    if (!igAccountId?.trim()) return { action: 'fetch' };

    const now = Date.now();
    const backoff = this.backoffUntil.get(igAccountId);
    if (backoff && backoff > now) {
      const cached = this.cache.get(igAccountId);
      if (cached) {
        return {
          action: 'cache_hit',
          followersCount: cached.followersCount,
          username: cached.username,
          fetchedAtMs: cached.fetchedAtMs
        };
      }
      logger.debug('[IG_ACCOUNT] Backoff active, no cache', { igAccountId });
      return { action: 'fetch' };
    }

    const cached = this.cache.get(igAccountId);
    if (cached && now - cached.fetchedAtMs < FRESH_MS) {
      return {
        action: 'cache_hit',
        followersCount: cached.followersCount,
        username: cached.username,
        fetchedAtMs: cached.fetchedAtMs
      };
    }

    const b = this.bucket(igAccountId, now);
    if (b.total >= this.totalCapPerHr) {
      logger.warn('[IG_ACCOUNT] Total hourly cap reached', { igAccountId, total: b.total });
      if (cached) {
        return {
          action: 'cache_hit',
          followersCount: cached.followersCount,
          username: cached.username,
          fetchedAtMs: cached.fetchedAtMs
        };
      }
      return { action: 'fetch' };
    }

    if (isOnDemandTrigger(trigger)) {
      if (b.onDemand >= this.onDemandCapPerHr) {
        logger.warn('[IG_ACCOUNT] On-demand hourly cap reached', { igAccountId, onDemand: b.onDemand });
        if (cached) {
          return {
            action: 'cache_hit',
            followersCount: cached.followersCount,
            username: cached.username,
            fetchedAtMs: cached.fetchedAtMs
          };
        }
        return { action: 'fetch' };
      }
    } else if (b.cron >= this.cronCapPerHr) {
      logger.warn('[IG_ACCOUNT] Cron hourly cap reached', { igAccountId, cron: b.cron });
      if (cached) {
        return {
          action: 'cache_hit',
          followersCount: cached.followersCount,
          username: cached.username,
          fetchedAtMs: cached.fetchedAtMs
        };
      }
      return { action: 'fetch' };
    }

    return { action: 'fetch' };
  }

  recordFetch(
    igAccountId: string,
    trigger: InstagramFetchTrigger,
    data: { followersCount: number; username?: string }
  ): void {
    if (!igAccountId?.trim()) return;
    const now = Date.now();
    this.cache.set(igAccountId, {
      followersCount: data.followersCount,
      username: data.username,
      fetchedAtMs: now
    });

    const b = this.bucket(igAccountId, now);
    b.total += 1;
    if (isOnDemandTrigger(trigger)) {
      b.onDemand += 1;
    } else {
      b.cron += 1;
    }
  }

  setBackoff(igAccountId: string, seconds: number): void {
    if (!igAccountId?.trim()) return;
    this.backoffUntil.set(igAccountId, Date.now() + Math.max(1, seconds) * 1000);
  }

  purge(igAccountId: string): void {
    this.cache.delete(igAccountId);
    this.hourly.delete(igAccountId);
    this.backoffUntil.delete(igAccountId);
  }
}

let instance: IgAccountFetchCoordinatorImpl | null = null;

export function getIgAccountFetchCoordinator(): IgAccountFetchCoordinatorImpl {
  if (!instance) instance = new IgAccountFetchCoordinatorImpl();
  return instance;
}

export function resetIgAccountFetchCoordinatorForTests(): void {
  instance = null;
}
