import * as fs from 'fs';
import * as path from 'path';

const CACHE_DIR = 'data/stimulate';

export interface StimCacheEntry {
  lastPublished: number;
  status: 'running' | 'done';
}

function cachePath(platform: string, deviceId: string): string {
  return path.join(CACHE_DIR, `${platform}_${deviceId}.json`);
}

export function readStimCache(platform: string, deviceId: string): StimCacheEntry | null {
  const fp = cachePath(platform, deviceId);
  try {
    const raw = fs.readFileSync(fp, 'utf-8');
    return JSON.parse(raw) as StimCacheEntry;
  } catch {
    return null;
  }
}

export function writeStimCache(platform: string, deviceId: string, entry: StimCacheEntry): void {
  const fp = cachePath(platform, deviceId);
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(entry, null, 2), 'utf-8');
}

export function clearStimCache(platform: string, deviceId: string): void {
  const fp = cachePath(platform, deviceId);
  try { fs.unlinkSync(fp); } catch { /* ok */ }
}
