import fs from 'fs';
import path from 'path';

export type SmapsFields = {
  rssKb: number | null;
  privateDirtyKb: number | null;
  privateCleanKb: number | null;
};

export type StatusFields = {
  vmRssKb: number | null;
  vmDataKb: number | null;
};

export type FileMeta = {
  path: string;
  bytes: number | null;
  mtimeMs: number | null;
};

const KB_LINE = /^(Rss|Private_Dirty|Private_Clean):\s+(\d+)\s+kB$/;
const STATUS_LINE = /^(VmRSS|VmData):\s+(\d+)\s+kB$/;

export function parseSmapsRollup(text: string): SmapsFields {
  const out: SmapsFields = { rssKb: null, privateDirtyKb: null, privateCleanKb: null };
  for (const raw of text.split('\n')) {
    const m = raw.trim().match(KB_LINE);
    if (!m) continue;
    const n = Number(m[2]);
    if (m[1] === 'Rss') out.rssKb = n;
    else if (m[1] === 'Private_Dirty') out.privateDirtyKb = n;
    else if (m[1] === 'Private_Clean') out.privateCleanKb = n;
  }
  return out;
}

export function parseProcStatus(text: string): StatusFields {
  const out: StatusFields = { vmRssKb: null, vmDataKb: null };
  for (const raw of text.split('\n')) {
    const m = raw.trim().match(STATUS_LINE);
    if (!m) continue;
    const n = Number(m[2]);
    if (m[1] === 'VmRSS') out.vmRssKb = n;
    else if (m[1] === 'VmData') out.vmDataKb = n;
  }
  return out;
}

export function readProcMemoryFields(): { smaps: SmapsFields | null; status: StatusFields | null } {
  let smaps: SmapsFields | null = null;
  let status: StatusFields | null = null;
  try {
    smaps = parseSmapsRollup(fs.readFileSync('/proc/self/smaps_rollup', 'utf8'));
  } catch {
    smaps = null;
  }
  try {
    status = parseProcStatus(fs.readFileSync('/proc/self/status', 'utf8'));
  } catch {
    status = null;
  }
  return { smaps, status };
}

export function statFileMeta(filePath: string): FileMeta {
  try {
    const st = fs.statSync(filePath);
    return { path: filePath, bytes: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return { path: filePath, bytes: null, mtimeMs: null };
  }
}

export function diagnosticFileMetas(dataDir: string, redisCsvPath?: string): FileMeta[] {
  const root = path.resolve(dataDir);
  const influxBase = path.join(root, 'influx-write-queue.lines');
  return [
    statFileMeta(redisCsvPath || path.join(root, 'redis_usage.csv')),
    statFileMeta(`${influxBase}.metrics`),
    statFileMeta(`${influxBase}.compliance`),
    statFileMeta(path.join(root, 'leak-hunter.jsonl')),
    statFileMeta(path.join(root, 'leak-hunter-latest.json'))
  ];
}

export function tryBunGc(full = true): boolean {
  const bun = (globalThis as { Bun?: { gc?: (force?: boolean) => void } }).Bun;
  if (typeof bun?.gc !== 'function') return false;
  bun.gc(full);
  return true;
}

export function rssWatchdogMb(): number {
  const n = parseInt(process.env.MEMORY_WATCHDOG_MB || '2048', 10);
  return Number.isFinite(n) && n > 0 ? n : 2048;
}
