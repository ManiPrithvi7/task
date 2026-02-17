/**
 * Device Service - MongoDB-based device management
 * Replaces file-based DeviceStorage
 * Updated to match Prisma schema
 * 
 * Also includes Redis-backed ActiveDeviceCache for zero-latency
 * active device lookups during publish cycles.
 */

import { Device, IDevice, DeviceStatus } from '../models/Device';
import { logger } from '../utils/logger';
import { getRedisService } from './redisService';
import mongoose from 'mongoose';

// ─── Active Device Cache (Redis-backed) ─────────────────────────────────────

const REDIS_ACTIVE_PREFIX = 'proof.mqtt:active:';

/**
 * Represents a device in the Redis active cache.
 * Cached at registration time to avoid per-cycle MongoDB reads.
 */
export interface ActiveDevice {
  deviceId: string;
  userId: string;
  adManagementEnabled: boolean;
  brandCanvasEnabled: boolean;
  lastSeen: number;  // epoch ms
}

/**
 * Redis-backed cache of currently-active devices.
 * Used by StatsPublisher for zero-latency device enumeration during publish cycles.
 * Written once at registration; removed on LWT / PUBACK timeout.
 */
export class ActiveDeviceCache {
  /**
   * Cache a device as active with its user preferences.
   */
  async setActive(device: ActiveDevice): Promise<void> {
    const redis = getRedisService();
    if (!redis || !redis.isRedisConnected()) return;

    try {
      const client = redis.getClient();
      const key = `${REDIS_ACTIVE_PREFIX}${device.deviceId}`;
      const value = JSON.stringify({
        deviceId: device.deviceId,
        userId: device.userId,
        adManagementEnabled: device.adManagementEnabled,
        brandCanvasEnabled: device.brandCanvasEnabled,
        lastSeen: new Date(device.lastSeen).toISOString()
      });

      await client.set(key, value, { EX: 86400 }); // 24h TTL

      logger.info('\uD83D\uDFE2 [REDIS:SET] Active device cached', {
        key,
        deviceId: device.deviceId,
        userId: device.userId,
        adManagementEnabled: device.adManagementEnabled,
        brandCanvasEnabled: device.brandCanvasEnabled,
        lastSeen: new Date(device.lastSeen).toISOString()
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Failed to cache active device', { deviceId: device.deviceId, error: msg });
    }
  }

  /**
   * Remove a device from the active cache (LWT / disconnect / timeout).
   */
  async removeActive(deviceId: string): Promise<boolean> {
    const redis = getRedisService();
    if (!redis || !redis.isRedisConnected()) return false;

    try {
      const client = redis.getClient();
      const key = `${REDIS_ACTIVE_PREFIX}${deviceId}`;
      const deleted = await client.del(key);
      return deleted > 0;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Failed to remove active device from cache', { deviceId, error: msg });
      return false;
    }
  }

  /**
   * Update the lastSeen timestamp for an active device (PUBACK confirmation).
   */
  async updateLastSeen(deviceId: string): Promise<void> {
    const redis = getRedisService();
    if (!redis || !redis.isRedisConnected()) return;

    try {
      const client = redis.getClient();
      const key = `${REDIS_ACTIVE_PREFIX}${deviceId}`;
      const raw = await client.get(key);
      if (!raw) return;

      const device = JSON.parse(raw);
      device.lastSeen = new Date().toISOString();
      await client.set(key, JSON.stringify(device), { EX: 86400 });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug('Failed to update lastSeen in Redis', { deviceId, error: msg });
    }
  }

  /**
   * Get all active devices from Redis (SCAN-based, no blocking).
   */
  async getAllActive(): Promise<ActiveDevice[]> {
    const redis = getRedisService();
    if (!redis || !redis.isRedisConnected()) return [];

    try {
      const client = redis.getClient();
      const devices: ActiveDevice[] = [];

      // SCAN for all active device keys
      const keys: string[] = [];
      for await (const key of client.scanIterator({ MATCH: `${REDIS_ACTIVE_PREFIX}*`, COUNT: 100 })) {
        keys.push(key);
      }

      logger.debug('\uD83D\uDCCB [REDIS:SCAN] Active devices retrieved', {
        count: keys.length,
        deviceIds: keys.map(k => k.replace(REDIS_ACTIVE_PREFIX, ''))
      });

      if (keys.length === 0) return [];

      // MGET all values in one round-trip
      const values = await client.mGet(keys);
      for (const val of values) {
        if (!val) continue;
        try {
          const parsed = JSON.parse(val);
          devices.push({
            deviceId: parsed.deviceId || '',
            userId: parsed.userId || '',
            adManagementEnabled: parsed.adManagementEnabled ?? true,
            brandCanvasEnabled: parsed.brandCanvasEnabled ?? false,
            lastSeen: parsed.lastSeen ? new Date(parsed.lastSeen).getTime() : Date.now()
          });
        } catch {
          // Skip malformed entries
        }
      }

      return devices;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Failed to get active devices from Redis', { error: msg });
      return [];
    }
  }

  /**
   * Flush all active device keys (used on startup to clear stale sessions).
   */
  async flushAll(): Promise<void> {
    const redis = getRedisService();
    if (!redis || !redis.isRedisConnected()) return;

    try {
      const client = redis.getClient();
      const keys: string[] = [];
      for await (const key of client.scanIterator({ MATCH: `${REDIS_ACTIVE_PREFIX}*`, COUNT: 100 })) {
        keys.push(key);
      }
      if (keys.length > 0) {
        await client.del(keys);
        logger.info('\uD83D\uDDD1\uFE0F [REDIS:FLUSH] Cleared stale active device keys', { count: keys.length });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('Failed to flush active device cache', { error: msg });
    }
  }
}

// Singleton
let activeDeviceCacheInstance: ActiveDeviceCache | null = null;

export function getActiveDeviceCache(): ActiveDeviceCache {
  if (!activeDeviceCacheInstance) {
    activeDeviceCacheInstance = new ActiveDeviceCache();
  }
  return activeDeviceCacheInstance;
}

// ─── Device Service (MongoDB-based) ─────────────────────────────────────────

export interface DeviceData {
  deviceId: string;
  username: string;
  status: 'active' | 'inactive';
  clientId: string;
  macID: string;
  lastSeen?: Date;
  metadata?: Record<string, any>;
}

export class DeviceService {
  private cleanupInterval?: NodeJS.Timeout;
  private cleanupIntervalMs: number;

  constructor(cleanupIntervalSeconds: number = 3600) {
    this.cleanupIntervalMs = cleanupIntervalSeconds * 1000;
  }

  /**
   * Initialize device service (start cleanup task)
   */
  async initialize(): Promise<void> {
    logger.info('DeviceService initialized (MongoDB)', {
      cleanupInterval: `${this.cleanupIntervalMs / 1000}s`
    });

    // Start periodic cleanup
    this.startCleanup();
  }

  /**
   * Register a new device or update existing
   */
  async registerDevice(data: DeviceData): Promise<IDevice> {
    try {
      // Prefer lookup by clientId (topic-derived deviceId), then by macID for legacy records
      let existing = await Device.findOne({ clientId: data.clientId });
      if (!existing && data.macID) {
        existing = await Device.findOne({ macID: data.macID });
        if (existing && existing.clientId !== data.clientId) {
          const oldClientId = existing.clientId;
          existing.clientId = data.clientId;
          logger.debug('Device normalized to topic id', { oldClientId, newClientId: data.clientId });
        }
      }

      if (existing) {
        // Update existing device
        existing.macID = data.macID;
        existing.lastSeenAt = new Date();
        existing.updatedAt = new Date();
        
        // Update status if it's not already active
        if (existing.status === DeviceStatus.OFFLINE) {
          existing.status = DeviceStatus.ACTIVE;
        }
        
        await existing.save();
        
        logger.info('Device updated', {
          deviceId: data.deviceId,
          clientId: data.clientId,
          status: existing.status
        });
        
        return existing;
      }

      // Create new device (honor data.status so MQTT-registered devices get ACTIVE and receive screen updates)
      const initialStatus = data.status === 'active' ? DeviceStatus.ACTIVE : DeviceStatus.UNALLOCATED;
      const device = new Device({
        userId: undefined, // Will be set when allocated to user
        macID: data.macID,
        crt: undefined, // Will be filled during provisioning
        ca_certificate: undefined, // Will be filled during provisioning
        clientId: data.clientId,
        status: initialStatus,
        tokenUsed: false,
        lastSeenAt: new Date()
      });

      await device.save();

      logger.info('Device registered', {
        deviceId: data.deviceId,
        clientId: data.clientId
      });

      return device;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to register device', {
        deviceId: data.deviceId,
        error: errorMessage
      });
      throw error;
    }
  }

  /**
   * Get device by client ID
   */
  async getDevice(clientId: string): Promise<DeviceData | null> {
    try {
      const device = await Device.findOne({ clientId });
      
      if (!device) {
        return null;
      }

      return {
        deviceId: device.clientId,
        username: device.userId?.toString() || 'unassigned',
        status: device.status === DeviceStatus.ACTIVE ? 'active' : 'inactive',
        clientId: device.clientId,
        macID: device.macID,
        lastSeen: device.lastSeenAt || device.updatedAt,
        metadata: {
          deviceStatus: device.status,
          provisionedAt: device.provisionedAt,
          allocatedAt: device.allocatedAt
        }
      };
    } catch (error) {
      logger.error('Failed to get device', { clientId, error });
      return null;
    }
  }

  /**
   * Get all devices
   */
  async getAllDevices(): Promise<Map<string, DeviceData>> {
    try {
      const devices = await Device.find();
      const deviceMap = new Map<string, DeviceData>();

      devices.forEach(device => {
        deviceMap.set(device.clientId, {
          deviceId: device.clientId,
          username: device.userId?.toString() || 'unassigned',
          status: device.status === DeviceStatus.ACTIVE ? 'active' : 'inactive',
          clientId: device.clientId,
          macID: device.macID,
          lastSeen: device.lastSeenAt || device.updatedAt,
          metadata: {
            deviceStatus: device.status,
            provisionedAt: device.provisionedAt,
            allocatedAt: device.allocatedAt
          }
        });
      });

      return deviceMap;
    } catch (error) {
      logger.error('Failed to get all devices', { error });
      return new Map();
    }
  }

  /**
   * Update device status
   */
  async updateDeviceStatus(clientId: string, status: 'active' | 'inactive'): Promise<void> {
    try {
      const device = await Device.findOne({ clientId });
      
      if (device) {
        // Map to DeviceStatus enum
        if (status === 'active') {
          device.status = DeviceStatus.ACTIVE;
        } else if (status === 'inactive') {
          device.status = DeviceStatus.OFFLINE;
        }
        
        device.lastSeenAt = new Date();
        device.updatedAt = new Date();
        await device.save();
        
        logger.debug('Device status updated', { clientId, status: device.status });
      }
    } catch (error) {
      logger.error('Failed to update device status', { clientId, status, error });
    }
  }

  /**
   * Update device last seen timestamp
   */
  async updateLastSeen(clientId: string): Promise<void> {
    try {
      await Device.updateOne(
        { clientId },
        { 
          $set: { 
            lastSeenAt: new Date(),
            updatedAt: new Date()
          } 
        }
      );
    } catch (error) {
      logger.error('Failed to update last seen', { clientId, error });
    }
  }

  /**
   * Get devices by user ID
   */
  async getDevicesByUserId(userId: string): Promise<DeviceData[]> {
    try {
      if (!mongoose.Types.ObjectId.isValid(userId)) {
        return [];
      }

      const devices = await Device.find({
        userId: new mongoose.Types.ObjectId(userId)
      });

      return devices.map(device => ({
        deviceId: device.clientId,
        username: device.userId?.toString() || 'unassigned',
        status: device.status === DeviceStatus.ACTIVE ? 'active' : 'inactive',
        clientId: device.clientId,
        macID: device.macID,
        lastSeen: device.lastSeenAt || device.updatedAt,
        metadata: {
          deviceStatus: device.status,
          provisionedAt: device.provisionedAt,
          allocatedAt: device.allocatedAt
        }
      }));
    } catch (error) {
      logger.error('Failed to get devices by user', { userId, error });
      return [];
    }
  }

  /**
   * Delete device
   */
  async deleteDevice(clientId: string): Promise<boolean> {
    try {
      const result = await Device.deleteOne({ clientId });
      
      if (result.deletedCount > 0) {
        logger.info('Device deleted', { clientId });
        return true;
      }
      
      return false;
    } catch (error) {
      logger.error('Failed to delete device', { clientId, error });
      return false;
    }
  }

  /**
   * Start cleanup task for inactive devices
   */
  private startCleanup(): void {
    this.cleanupInterval = setInterval(async () => {
      await this.cleanupInactiveDevices();
    }, this.cleanupIntervalMs);

    logger.info('Device cleanup task started');
  }

  /**
   * Cleanup devices inactive for more than configured period
   */
  private async cleanupInactiveDevices(): Promise<void> {
    try {
      const cutoffTime = new Date(Date.now() - this.cleanupIntervalMs);
      
      // Only cleanup devices that are OFFLINE and haven't been seen in a while
      const result = await Device.deleteMany({
        status: DeviceStatus.OFFLINE,
        lastSeenAt: { $lt: cutoffTime }
      });

      if (result.deletedCount > 0) {
        logger.info('Cleaned up inactive devices', {
          count: result.deletedCount,
          cutoffTime: cutoffTime.toISOString()
        });
      }
    } catch (error) {
      logger.error('Failed to cleanup inactive devices', { error });
    }
  }

  /**
   * Stop cleanup task and close
   */
  async close(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      logger.info('Device cleanup task stopped');
    }
  }
}

