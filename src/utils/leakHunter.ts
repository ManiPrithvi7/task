import fs from 'fs/promises';
import path from 'path';
import { stimCacheSize } from '../../stimulate/cache';
import { getIgDeviceRuntimeCache } from '../services/igDeviceRuntimeCache';
import { getInfluxService } from '../services/influxService';
import { influxQueryCacheSize } from '../services/influxQueryCache';
import { getIgFetchBodySizeSnapshot } from '../lib/socials/instagramMetrics';
import { getInstagramPollingMetricsSnapshot } from '../services/instagramService';
import { getLocalPromoRotationCache, getLocalPublishHashCache } from '../services/localCaches';
import { getRedisService } from '../services/redisService';
import { logger } from './logger';

export type AppLeakSnapshot = {
  mqttPendingAcks: number;
  deferredPending: number;
  ingressBuffer: number;
};

export type StoreReading = {
  key: string;
  module: string;
  file: string;
  count: number;
};

export type StoreDelta = StoreReading & { delta: number };

const MAX_JSONL_BYTES = 2 * 1024 * 1024;

let timer: ReturnType<typeof setInterval> | null = null;
let lastRss = 0;
let lastStores: StoreReading[] | null = null;
let sampleTicks = 0;

function dataDir(): string {
  return path.resolve(process.env.DATA_DIR || './data');
}

export function leakHunterJsonlPath(): string {
  return path.join(dataDir(), 'leak-hunter.jsonl');
}

export function leakHunterLatestPath(): string {
  return path.join(dataDir(), 'leak-hunter-latest.json');
}

function safeCount(read: () => number): number {
  try {
    const n = read();
    return typeof n === 'number' && Number.isFinite(n) ? n : -1;
  } catch {
    return -1;
  }
}

export function readStoreSizes(appSnapshot?: AppLeakSnapshot): StoreReading[] {
  return [
    {
      key: 'influx.usageLogQueue',
      module: 'InfluxService',
      file: 'src/services/influxService.ts',
      count: safeCount(() => getInfluxService()?.usageLogQueueLength() ?? -1)
    },
    {
      key: 'influx.queryCache',
      module: 'influxQueryCache',
      file: 'src/services/influxQueryCache.ts',
      count: safeCount(influxQueryCacheSize)
    },
    {
      key: 'redis.usageLogQueue',
      module: 'RedisService',
      file: 'src/services/redisService.ts',
      count: safeCount(() => getRedisService()?.usageLogQueueLength() ?? -1)
    },
    {
      key: 'maps.igDeviceRuntime',
      module: 'IgDeviceRuntimeCache',
      file: 'src/services/igDeviceRuntimeCache.ts',
      count: safeCount(() => getIgDeviceRuntimeCache().size())
    },
    {
      key: 'maps.publishHash',
      module: 'LocalPublishHashCache',
      file: 'src/services/localCaches.ts',
      count: safeCount(() => getLocalPublishHashCache().size())
    },
    {
      key: 'maps.promoRotation',
      module: 'LocalPromoRotationCache',
      file: 'src/services/localCaches.ts',
      count: safeCount(() => getLocalPromoRotationCache().size())
    },
    {
      key: 'maps.stimCache',
      module: 'stimulate/cache',
      file: 'stimulate/cache.ts',
      count: safeCount(stimCacheSize)
    },
    {
      key: 'mqtt.pendingAcks',
      module: 'MqttClientManager',
      file: 'src/servers/mqttClient.ts',
      count: appSnapshot?.mqttPendingAcks ?? -1
    },
    {
      key: 'mqtt.deferredPending',
      module: 'DeferredDeviceWorkQueue',
      file: 'src/services/deferredDeviceWork.ts',
      count: appSnapshot?.deferredPending ?? -1
    },
    {
      key: 'mqtt.ingressBuffer',
      module: 'mqttIngressRouter',
      file: 'src/services/mqttIngressRouter.ts',
      count: appSnapshot?.ingressBuffer ?? -1
    }
  ];
}

/** Name stores whose retained size went up. Ignores -1 (not ready). */
export function diagnoseStores(
  prev: StoreReading[] | null,
  curr: StoreReading[],
  rssDeltaKb: number
): { suspect: string; growing: StoreDelta[]; note: string } {
  const growing: StoreDelta[] = [];
  if (prev) {
    const prevByKey = new Map(prev.map((s) => [s.key, s.count]));
    for (const s of curr) {
      const before = prevByKey.get(s.key);
      if (before === undefined || before < 0 || s.count < 0) continue;
      const delta = s.count - before;
      if (delta > 0) growing.push({ ...s, delta });
    }
  }

  growing.sort((a, b) => b.delta - a.delta);

  if (growing.length > 0 && rssDeltaKb > 0) {
    return {
      suspect: growing[0].module,
      growing,
      note: `${growing[0].module} grew (+${growing[0].delta} on ${growing[0].key}) while RSS rose ${rssDeltaKb} KB`
    };
  }
  if (growing.length > 0) {
    return {
      suspect: growing[0].module,
      growing,
      note: `${growing[0].module} grew (+${growing[0].delta} on ${growing[0].key}); RSS did not rise this tick`
    };
  }
  if (rssDeltaKb > 2048) {
    return {
      suspect: 'untracked_native_or_heap',
      growing,
      note: `RSS +${rssDeltaKb} KB but watched stores are flat — Bun/native/SDK or a store not in this list`
    };
  }
  return {
    suspect: 'none',
    growing,
    note: 'No watched store grew'
  };
}

export function collectLeakDiagnostics(appSnapshot?: AppLeakSnapshot): Record<string, unknown> {
  const mu = process.memoryUsage();
  const delta = lastRss === 0 ? 0 : mu.rss - lastRss;
  const stores = readStoreSizes(appSnapshot);
  const diagnosis = diagnoseStores(lastStores, stores, Math.round(delta / 1024));
  lastRss = mu.rss;
  lastStores = stores;

  const igPoll = getInstagramPollingMetricsSnapshot();
  const bodies = getIgFetchBodySizeSnapshot();
  return {
    timestamp: new Date().toISOString(),
    memory: {
      rss_mb: Math.round(mu.rss / 1024 / 1024),
      heapUsed_mb: Math.round(mu.heapUsed / 1024 / 1024),
      external_mb: Math.round(mu.external / 1024 / 1024),
      delta_kb: Math.round(delta / 1024)
    },
    diagnosis,
    stores,
    redisConnected: getRedisService()?.isRedisConnected() ?? false,
    igPoll,
    igPipeline: {
      fetchesEnqueued: Number(igPoll.fetchesEnqueued ?? 0),
      fetchesApplied: Number(igPoll.fetchesApplied ?? 0),
      fetchesSucceeded: Number(igPoll.fetchesSucceeded ?? 0),
      fetchesFailed: Number(igPoll.fetchesFailed ?? 0),
      fetchesNoCredentials: Number(igPoll.fetchesNoCredentials ?? 0),
      correlationPending: Number(igPoll.correlationPending ?? 0),
      lastGraphResponseBytes: bodies.lastGraphResponseBytes,
      lastDetailsJsonBytes: bodies.lastDetailsJsonBytes
    }
  };
}

async function rotateIfHuge(filePath: string): Promise<void> {
  try {
    const st = await fs.stat(filePath);
    if (st.size <= MAX_JSONL_BYTES) return;
    // ponytail: drop history at 2MB so the hunter cannot fill the disk
    await fs.unlink(filePath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw err;
  }
}

async function writeReport(payload: Record<string, unknown>): Promise<void> {
  const dir = dataDir();
  await fs.mkdir(dir, { recursive: true });
  const jsonl = leakHunterJsonlPath();
  const latest = leakHunterLatestPath();
  await rotateIfHuge(jsonl);
  await fs.appendFile(jsonl, `${JSON.stringify(payload)}\n`, 'utf8');
  await fs.writeFile(latest, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

export function startLeakHunter(getAppSnapshot?: () => AppLeakSnapshot): void {
  if (timer) return;
  lastRss = 0;
  lastStores = null;
  sampleTicks = 0;
  logger.info('leak hunter writing local diagnose files', {
    latest: leakHunterLatestPath(),
    history: leakHunterJsonlPath(),
    intervalMs: 30_000
  });
  const tick = (): void => {
    const payload = collectLeakDiagnostics(getAppSnapshot?.());
    sampleTicks += 1;
    // ponytail: Railway has no SSH to the JSON files; one sample / 5 min is the watch surface
    if (sampleTicks % 10 === 0) {
      logger.info('leak_hunter_sample', {
        rss_mb: (payload.memory as { rss_mb?: number }).rss_mb,
        suspect: (payload.diagnosis as { suspect?: string }).suspect,
        igPipeline: payload.igPipeline
      });
    }
    void writeReport(payload).catch((err: unknown) => {
      logger.warn('leak hunter file write failed', {
        error: err instanceof Error ? err.message : String(err)
      });
    });
  };
  tick();
  timer = setInterval(tick, 30_000);
  timer.unref?.();
}

export function stopLeakHunter(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  lastRss = 0;
  lastStores = null;
  sampleTicks = 0;
}
