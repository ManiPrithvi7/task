import { logger } from './logger';

const MB = (n: number) => Math.round((n / 1048576) * 10) / 10;

const gauges: Record<string, () => number | Promise<number>> = {};

export function registerMemoryGauge(name: string, fn: () => number | Promise<number>): void {
  gauges[name] = fn;
}

export async function sampleDiag(): Promise<Record<string, number | string>> {
  const rssPreGC = MB(process.memoryUsage().rss);
  if (typeof Bun.gc === 'function') {
    Bun.gc(true);
  }
  const m = process.memoryUsage();

  const diag: Record<string, number | string> = {
    uptimeSec: Math.round(process.uptime()),
    bunVersion: Bun.version,
    rssPreGCMB: rssPreGC,
    rssMB: MB(m.rss),
    heapMB: MB(m.heapUsed),
    extMB: MB(m.external),
    nativeMB: MB(m.rss - m.heapUsed - m.external),
    activeHandles:
      typeof process.getActiveResourcesInfo === 'function'
        ? process.getActiveResourcesInfo().length
        : -1
  };

  for (const [name, fn] of Object.entries(gauges)) {
    try {
      diag[name] = await fn();
    } catch {
      diag[name] = -1;
    }
  }
  return diag;
}

const MEMORY_INTERVAL_MS = 2 * 60 * 1000;
let memoryLogTimer: ReturnType<typeof setInterval> | null = null;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;

export function formatMemoryBlock(m: NodeJS.MemoryUsage): Record<string, string> {
  return {
    rss: `${(m.rss / 1024 / 1024).toFixed(2)} MB`,
    heapTotal: `${(m.heapTotal / 1024 / 1024).toFixed(2)} MB`,
    heapUsed: `${(m.heapUsed / 1024 / 1024).toFixed(2)} MB`,
    external: `${(m.external / 1024 / 1024).toFixed(2)} MB`,
    arrayBuffers: `${(m.arrayBuffers / 1024 / 1024).toFixed(2)} MB`
  };
}

export async function emitMemoryUsage(metrics: Record<string, number>): Promise<void> {
  const memory = formatMemoryBlock(process.memoryUsage());
  const diag = await sampleDiag();
  logger.info('memory_usage', { memory, metrics, diag });
}

function startRssWatchdog(): void {
  if (watchdogTimer) return;
  const LIMIT_MB = Number(process.env.MEMORY_WATCHDOG_MB ?? 1536);
  watchdogTimer = setInterval(() => {
    const rss = process.memoryUsage().rss / 1048576;
    if (rss > LIMIT_MB) {
      logger.warn(`rss watchdog tripped at ${rss.toFixed(0)} MB (limit ${LIMIT_MB}), exiting`);
      process.exit(1);
    }
  }, 60_000);
  watchdogTimer.unref?.();
}

export function startMemoryUsageLogger(tick: () => void | Promise<void>): void {
  if (memoryLogTimer) return;
  void tick();
  memoryLogTimer = setInterval(() => {
    void tick();
  }, MEMORY_INTERVAL_MS);
  memoryLogTimer.unref?.();
  startRssWatchdog();
}

export function stopMemoryUsageLogger(): void {
  if (memoryLogTimer) {
    clearInterval(memoryLogTimer);
    memoryLogTimer = null;
  }
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}
