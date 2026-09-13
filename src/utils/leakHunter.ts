import { readFileSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { stimCacheSize } from '../../stimulate/cache';
import { getIgDeviceRuntimeCache } from '../services/igDeviceRuntimeCache';
import { getInfluxService } from '../services/influxService';
import { influxQueryCacheSize } from '../services/influxQueryCache';
import { getIgFetchBodySizeSnapshot } from '../lib/socials/instagramMetrics';
import { getInstagramPollingMetricsSnapshot } from '../services/instagramService';
import { getLocalPromoRotationCache, getLocalPublishHashCache } from '../services/localCaches';
import { getActiveDeviceCache } from '../services/deviceService';
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

export type ProcRollup = {
  rss_kb: number;
  pss_kb: number;
  private_dirty_kb: number;
  private_clean_kb: number;
  anon_huge_pages_kb: number;
};

export type ProcRegion = { name: string; rss_kb: number };

export type ProcSelfSnapshot = {
  rollup: ProcRollup | null;
  vm_hwm_kb: number | null;
  threads: number | null;
  top_rss: ProcRegion[];
};

const MAX_JSONL_BYTES = 2 * 1024 * 1024;
export const UNTRACKED_SLOPE_SAMPLES = 10;
export const UNTRACKED_SLOPE_KB = 10 * 1024;
const PROC_TOP_RSS = 5;

let timer: ReturnType<typeof setInterval> | null = null;
let lastRss = 0;
let lastStores: StoreReading[] | null = null;
let sampleTicks = 0;
const rssWindowKb: number[] = [];

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
  rssDeltaKb: number,
  rssSlopeKb = 0
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
  if (rssSlopeKb >= UNTRACKED_SLOPE_KB) {
    return {
      suspect: 'untracked_native_or_heap',
      growing,
      note: `RSS +${rssSlopeKb} KB over ${UNTRACKED_SLOPE_SAMPLES} samples; stores flat — Bun/native/SDK or a store not in this list`
    };
  }
  return {
    suspect: 'none',
    growing,
    note: 'No watched store grew'
  };
}

function kbField(text: string, key: string): number | null {
  const m = text.match(new RegExp(`^${key}:\\s*(\\d+)\\s*kB`, 'im'));
  return m ? Number(m[1]) : null;
}

export function parseSmapsRollup(text: string): ProcRollup | null {
  const rss = kbField(text, 'Rss');
  if (rss == null) return null;
  return {
    rss_kb: rss,
    pss_kb: kbField(text, 'Pss') ?? 0,
    private_dirty_kb: kbField(text, 'Private_Dirty') ?? 0,
    private_clean_kb: kbField(text, 'Private_Clean') ?? 0,
    anon_huge_pages_kb: kbField(text, 'AnonHugePages') ?? 0
  };
}

export function parseStatusVmAndThreads(text: string): {
  vm_hwm_kb: number | null;
  threads: number | null;
} {
  const hwm = text.match(/^VmHWM:\s*(\d+)\s*kB/im);
  const th = text.match(/^Threads:\s*(\d+)/im);
  return {
    vm_hwm_kb: hwm ? Number(hwm[1]) : null,
    threads: th ? Number(th[1]) : null
  };
}

export function parseSmapsTopRss(text: string, limit = PROC_TOP_RSS): ProcRegion[] {
  const byName = new Map<string, number>();
  let name = 'anon';
  for (const line of text.split('\n')) {
    if (/^[0-9a-f]+-[0-9a-f]+\s/i.test(line)) {
      const parts = line.trim().split(/\s+/);
      const last = parts[parts.length - 1] ?? '';
      name = last.startsWith('/') || last.startsWith('[') ? last : 'anon';
      continue;
    }
    const rss = line.match(/^Rss:\s*(\d+)\s*kB/i);
    if (rss) byName.set(name, (byName.get(name) ?? 0) + Number(rss[1]));
  }
  return [...byName.entries()]
    .map(([n, rss_kb]) => ({ name: n, rss_kb }))
    .sort((a, b) => b.rss_kb - a.rss_kb)
    .slice(0, limit);
}

export function readProcSelfSnapshot(): ProcSelfSnapshot {
  const empty: ProcSelfSnapshot = { rollup: null, vm_hwm_kb: null, threads: null, top_rss: [] };
  try {
    const rollup = parseSmapsRollup(readFileSync('/proc/self/smaps_rollup', 'utf8'));
    const st = parseStatusVmAndThreads(readFileSync('/proc/self/status', 'utf8'));
    let top_rss: ProcRegion[] = [];
    try {
      top_rss = parseSmapsTopRss(readFileSync('/proc/self/smaps', 'utf8'));
    } catch {
      /* rollup + status still useful */
    }
    return { rollup, vm_hwm_kb: st.vm_hwm_kb, threads: st.threads, top_rss };
  } catch {
    return empty;
  }
}

export async function collectLeakDiagnostics(appSnapshot?: AppLeakSnapshot): Promise<Record<string, unknown>> {
  const mu = process.memoryUsage();
  const delta = lastRss === 0 ? 0 : mu.rss - lastRss;
  const rssKb = Math.round(mu.rss / 1024);
  rssWindowKb.push(rssKb);
  if (rssWindowKb.length > UNTRACKED_SLOPE_SAMPLES) rssWindowKb.shift();
  const rssSlopeKb =
    rssWindowKb.length >= UNTRACKED_SLOPE_SAMPLES
      ? rssWindowKb[rssWindowKb.length - 1] - rssWindowKb[0]
      : 0;
  const stores = readStoreSizes(appSnapshot);
  const diagnosis = diagnoseStores(lastStores, stores, Math.round(delta / 1024), rssSlopeKb);
  lastRss = mu.rss;
  lastStores = stores;

  let activeDevicesCount = -1;
  try {
    activeDevicesCount = await getActiveDeviceCache().count();
  } catch {
    activeDevicesCount = -1;
  }

  const igPoll = getInstagramPollingMetricsSnapshot();
  const bodies = getIgFetchBodySizeSnapshot();
  return {
    timestamp: new Date().toISOString(),
    memory: {
      rss_mb: Math.round(mu.rss / 1024 / 1024),
      heapTotal_mb: Math.round(mu.heapTotal / 1024 / 1024),
      heapUsed_mb: Math.round(mu.heapUsed / 1024 / 1024),
      external_mb: Math.round(mu.external / 1024 / 1024),
      arrayBuffers_mb: Math.round(mu.arrayBuffers / 1024 / 1024),
      delta_kb: Math.round(delta / 1024)
    },
    activeDevicesCount,
    proc: readProcSelfSnapshot(),
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
  rssWindowKb.length = 0;
  logger.info('leak hunter writing local diagnose files', {
    latest: leakHunterLatestPath(),
    history: leakHunterJsonlPath(),
    intervalMs: 30_000
  });
  const tick = (): void => {
    void collectLeakDiagnostics(getAppSnapshot?.())
      .then((payload) => {
        sampleTicks += 1;
        // ponytail: Railway has no SSH to the JSON files; one sample / 5 min is the watch surface
        if (sampleTicks % 10 === 0) {
          const mem = payload.memory as {
            rss_mb?: number;
            heapTotal_mb?: number;
            arrayBuffers_mb?: number;
          };
          logger.info('leak_hunter_sample', {
            rss_mb: mem.rss_mb,
            heapTotal_mb: mem.heapTotal_mb,
            arrayBuffers_mb: mem.arrayBuffers_mb,
            activeDevicesCount: payload.activeDevicesCount,
            proc: payload.proc,
            suspect: (payload.diagnosis as { suspect?: string }).suspect,
            igPipeline: payload.igPipeline
          });
        }
        return writeReport(payload);
      })
      .catch((err: unknown) => {
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
  rssWindowKb.length = 0;
}
