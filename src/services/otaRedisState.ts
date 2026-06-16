/**
 * Redis-backed OTA fleet state — active release, pending/delivered device sets.
 */

import type { RedisClientType } from 'redis';
import { logger } from '../utils/logger';

export interface OtaActiveRelease {
  version: string;
  sha256: string;
  signature: string;
  objectKey: string;
  sizeBytes: number;
  releasedAt: string;
}

export class OtaRedisState {
  constructor(
    private readonly getClient: () => RedisClientType | null,
    private readonly keyPrefix: string
  ) {}

  private activeReleaseKey(): string {
    return `${this.keyPrefix}ota:active_release`;
  }

  private pendingKey(version: string): string {
    return `${this.keyPrefix}ota:pending:${version}`;
  }

  private deliveredKey(version: string): string {
    return `${this.keyPrefix}ota:delivered:${version}`;
  }

  async setActiveRelease(release: OtaActiveRelease): Promise<void> {
    const client = this.getClient();
    if (!client) {
      logger.warn('[OTA] Redis unavailable — skipping setActiveRelease');
      return;
    }
    await client.set(this.activeReleaseKey(), JSON.stringify(release));
  }

  async getActiveRelease(): Promise<OtaActiveRelease | null> {
    const client = this.getClient();
    if (!client) return null;
    const raw = await client.get(this.activeReleaseKey());
    if (!raw) return null;
    try {
      return JSON.parse(raw) as OtaActiveRelease;
    } catch {
      return null;
    }
  }

  async seedPendingFleet(version: string, deviceIds: string[]): Promise<void> {
    const client = this.getClient();
    if (!client || deviceIds.length === 0) return;
    const key = this.pendingKey(version);
    await client.del(key);
    await client.sAdd(key, deviceIds);
  }

  async isPending(deviceId: string, version: string): Promise<boolean> {
    const client = this.getClient();
    if (!client) return true;
    return (await client.sIsMember(this.pendingKey(version), deviceId)) === 1;
  }

  async isDelivered(deviceId: string, version: string): Promise<boolean> {
    const client = this.getClient();
    if (!client) return false;
    return (await client.sIsMember(this.deliveredKey(version), deviceId)) === 1;
  }

  async markDelivered(deviceId: string, version: string): Promise<void> {
    const client = this.getClient();
    if (!client) return;
    await client.sRem(this.pendingKey(version), deviceId);
    await client.sAdd(this.deliveredKey(version), deviceId);
  }

  async markPending(deviceId: string, version: string): Promise<void> {
    const client = this.getClient();
    if (!client) return;
    await client.sAdd(this.pendingKey(version), deviceId);
  }
}
