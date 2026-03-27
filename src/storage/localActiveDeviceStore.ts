import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import type { ActiveDevice } from '../services/deviceService';

type LocalStoreFile = {
  version: 1;
  updatedAt: string;
  devices: Record<string, ActiveDevice>;
};

export class LocalActiveDeviceStore {
  private filePath: string;

  constructor(dataDir: string) {
    // Store under data dir so it survives restarts (local persistence)
    this.filePath = path.resolve(dataDir, 'active-devices.json');
  }

  async upsert(device: ActiveDevice): Promise<void> {
    const data = await this.readFileSafe();
    data.devices[device.deviceId] = device;
    data.updatedAt = new Date().toISOString();
    await this.writeFileAtomic(data);
  }

  async remove(deviceId: string): Promise<void> {
    const data = await this.readFileSafe();
    if (data.devices[deviceId]) {
      delete data.devices[deviceId];
      data.updatedAt = new Date().toISOString();
      await this.writeFileAtomic(data);
    }
  }

  async getAll(): Promise<ActiveDevice[]> {
    const data = await this.readFileSafe();
    return Object.values(data.devices);
  }

  async clear(): Promise<number> {
    const data = await this.readFileSafe();
    const count = Object.keys(data.devices).length;
    if (count === 0) return 0;
    data.devices = {};
    data.updatedAt = new Date().toISOString();
    await this.writeFileAtomic(data);
    return count;
  }

  async updateLastSeen(deviceId: string, lastSeen: number): Promise<void> {
    const data = await this.readFileSafe();
    const existing = data.devices[deviceId];
    if (!existing) return;
    existing.lastSeen = lastSeen;
    data.updatedAt = new Date().toISOString();
    await this.writeFileAtomic(data);
  }

  private async readFileSafe(): Promise<LocalStoreFile> {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      if (!fs.existsSync(this.filePath)) {
        return { version: 1, updatedAt: new Date().toISOString(), devices: {} };
      }
      const raw = await fs.promises.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<LocalStoreFile>;
      return {
        version: 1,
        updatedAt: parsed.updatedAt || new Date().toISOString(),
        devices: parsed.devices || {}
      };
    } catch (err: unknown) {
      logger.warn('LocalActiveDeviceStore: failed to read, treating as empty', {
        path: this.filePath,
        error: err instanceof Error ? err.message : String(err)
      });
      return { version: 1, updatedAt: new Date().toISOString(), devices: {} };
    }
  }

  private async writeFileAtomic(data: LocalStoreFile): Promise<void> {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const tmp = `${this.filePath}.tmp`;
    const json = JSON.stringify(data);
    await fs.promises.writeFile(tmp, json, { encoding: 'utf8', mode: 0o600 });
    await fs.promises.rename(tmp, this.filePath);
  }
}

