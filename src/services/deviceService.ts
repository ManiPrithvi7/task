/**
 * Device Service - MongoDB-based device management + Redis active device cache
 *
 * MongoDB: Permanent device records (register, status, cleanup)
 * Redis:   Real-time active device cache (proof.mqtt:active:{deviceId})
 *          Stores userId + user preferences for zero-MongoDB publish cycles
 */

import { Device, IDevice, DeviceStatus } from '../models/Device';
import { RedisClientType } from 'redis';
import { getRedisService } from './redisService';
import { logger } from '../utils/logger';
import mongoose from 'mongoose';

// ─── Redis Active Device Cache ───────────────────────────────────────────────

const ACTIVE_PREFIX = 'proof.mqtt:active:';

export interface ActiveDevice {
  deviceId: string;
  userId: string;
  adManagementEnabled: boolean;
  brandCanvasEnabled: boolean;
  lastSeen: number;
}

export class ActiveDeviceCache {
  private getRedis(): RedisClientType | null {
    const svc = getRedisService();
    if (!svc || !svc.isRedisConnected()) return null;
    return svc.getClient();
  }

  /**
   * Register a device as active with user preferences.
   * Called once when device publishes to /active topic.
   */
  async setActive(device: ActiveDevice): Promise<boolean> {
    const redis = this.getRedis();
    if (!redis) {
      logger.warn('ActiveDeviceCache: Redis unavailable, cannot cache active device', { deviceId: device.deviceId });
      return false;
    }

    try {
      const key = `${ACTIVE_PREFIX}${device.deviceId}`;
      const value = JSON.stringify(device);
      await redis.set(key, value);
      logger.info('🟢 [REDIS:SET] Active device cached', {
        key,
        deviceId: device.deviceId,
        userId: device.userId || '(no user)',
        adManagementEnabled: device.adManagementEnabled,
        brandCanvasEnabled: device.brandCanvasEnabled,
        lastSeen: new Date(device.lastSeen).toISOString()
      });
      return true;
    } catch (err: unknown) {
      logger.error('ActiveDeviceCache: failed to set active device', {
        deviceId: device.deviceId,
        error: err instanceof Error ? err.message : String(err)
      });
      return false;
    }
  }

  /**
   * Remove a device from the active cache.
   * Called on LWT, PUBACK timeout, or explicit unregistration.
   */
  async removeActive(deviceId: string): Promise<boolean> {
    const redis = this.getRedis();
    if (!redis) return false;

    try {
      const key = `${ACTIVE_PREFIX}${deviceId}`;
      const deleted = await redis.del(key);
      if (deleted > 0) {
        logger.info('🔴 [REDIS:DEL] Active device removed', { key, deviceId });
      } else {
        logger.debug('🔴 [REDIS:DEL] Key not found (device was not cached)', { key, deviceId });
      }
      return deleted > 0;
    } catch (err: unknown) {
      logger.error('ActiveDeviceCache: failed to remove active device', {
        deviceId,
        error: err instanceof Error ? err.message : String(err)
      });
      return false;
    }
  }

  /**
   * Update lastSeen timestamp for an active device (on PUBACK received).
   */
  async updateLastSeen(deviceId: string): Promise<void> {
    const redis = this.getRedis();
    if (!redis) return;

    try {
      const key = `${ACTIVE_PREFIX}${deviceId}`;
      const raw = await redis.get(key);
      if (!raw) {
        logger.debug('🕐 [REDIS:LASTSEEN] Skip — device not in active cache', { deviceId });
        return;
      }

      const entry: ActiveDevice = JSON.parse(raw);
      const previousSeen = entry.lastSeen;
      entry.lastSeen = Date.now();
      await redis.set(key, JSON.stringify(entry));
      logger.debug('🕐 [REDIS:LASTSEEN] Updated', {
        deviceId,
        previousSeen: new Date(previousSeen).toISOString(),
        newSeen: new Date(entry.lastSeen).toISOString()
      });
    } catch (err: unknown) {
      logger.error('ActiveDeviceCache: failed to update lastSeen', {
        deviceId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  /**
   * Get a single active device entry.
   */
  async getActive(deviceId: string): Promise<ActiveDevice | null> {
    const redis = this.getRedis();
    if (!redis) return null;

    try {
      const raw = await redis.get(`${ACTIVE_PREFIX}${deviceId}`);
      if (!raw) return null;
      return JSON.parse(raw) as ActiveDevice;
    } catch (err: unknown) {
      logger.error('ActiveDeviceCache: failed to get active device', {
        deviceId,
        error: err instanceof Error ? err.message : String(err)
      });
      return null;
    }
  }

  /**
   * Get ALL active devices from Redis using SCAN (non-blocking).
   * This is the hot-path method called every publish cycle.
   */
  async getAllActive(): Promise<ActiveDevice[]> {
    const redis = this.getRedis();
    if (!redis) return [];

    try {
      const devices: ActiveDevice[] = [];
      let cursor = 0;

      do {
        const result = await redis.scan(cursor, { MATCH: `${ACTIVE_PREFIX}*`, COUNT: 100 });
        cursor = result.cursor;

        if (result.keys.length > 0) {
          const values = await redis.mGet(result.keys);
          for (const val of values) {
            if (val) {
              try {
                devices.push(JSON.parse(val) as ActiveDevice);
              } catch { /* skip malformed entries */ }
            }
          }
        }
      } while (cursor !== 0);

      logger.debug('📋 [REDIS:SCAN] Active devices retrieved', {
        count: devices.length,
        deviceIds: devices.map(d => d.deviceId)
      });
      return devices;
    } catch (err: unknown) {
      logger.error('ActiveDeviceCache: failed to scan active devices', {
        error: err instanceof Error ? err.message : String(err)
      });
      return [];
    }
  }

  /**
   * Flush all active device keys on server startup (stale from previous session).
   */
  async flushAll(): Promise<number> {
    const redis = this.getRedis();
    if (!redis) return 0;

    try {
      let deleted = 0;
      let cursor = 0;

      do {
        const result = await redis.scan(cursor, { MATCH: `${ACTIVE_PREFIX}*`, COUNT: 100 });
        cursor = result.cursor;

        if (result.keys.length > 0) {
          await redis.del(result.keys);
          deleted += result.keys.length;
        }
      } while (cursor !== 0);

      logger.info('🧹 [REDIS:FLUSH] Startup flush completed', {
        deletedKeys: deleted,
        pattern: `${ACTIVE_PREFIX}*`
      });
      return deleted;
    } catch (err: unknown) {
      logger.error('ActiveDeviceCache: failed to flush active keys', {
        error: err instanceof Error ? err.message : String(err)
      });
      return 0;
    }
  }

  /**
   * Get count of active devices.
   */
  async count(): Promise<number> {
    const devices = await this.getAllActive();
    return devices.length;
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

// ─── MongoDB Device Service ──────────────────────────────────────────────────

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

