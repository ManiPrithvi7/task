/**
 * Device Service - MongoDB-based device management + Redis active device cache
 *
 * MongoDB: Permanent device records (register, status, cleanup)
 * Redis:   Real-time active device cache (proof.mqtt:active:{deviceId})
 *          Stores userId + user preferences for zero-MongoDB publish cycles
 */

import { Device, IDevice, DeviceStatus } from '../models/Device';
import { DeviceOtaState } from '../models/DeviceOtaState';
import { logger } from '../utils/logger';
import { withMongoRetry } from '../utils/mongoRetry';
import mongoose from 'mongoose';
import { LocalActiveDeviceStore } from '../storage/localActiveDeviceStore';

// ─── Active Device Cache (LOCAL PERSISTENCE PRIMARY) ────────────────────────
// Development testing mode: local file persistence is the source-of-truth.
// Redis-based active device cache is intentionally disabled here.

const ACTIVE_PREFIX = 'proof.mqtt:active:';

export interface ActiveDevice {
  deviceId: string;
  businessId: string;
  lastSeen: number;
  /** Present when `Social` has `INSTAGRAM` for `Device.businessId` (written at `/active` registration). */
  instagramAccountId?: string;
  /** Same source as Redis `proof.mqtt:device:{id}`. */
  accessToken?: string;
}

/** Legacy local-file entries predate the userId→businessId rename. */
function normalizeActiveDevice(d: ActiveDevice & { userId?: string }): ActiveDevice {
  if (d.businessId === undefined && typeof d.userId === 'string') {
    return { ...d, businessId: d.userId };
  }
  return d;
}

export class ActiveDeviceCache {
  private localStore: LocalActiveDeviceStore;

  constructor(dataDir: string = process.env.DATA_DIR || './data') {
    this.localStore = new LocalActiveDeviceStore(dataDir);
  }

  /**
   * Register a device as active with user preferences.
   * Called once when device publishes to /active topic.
   */
  async setActive(device: ActiveDevice): Promise<boolean> {
    try {
      // Primary: local persistence
      await this.localStore.upsert(device);
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
    try {
      // Primary: local persistence
      await this.localStore.remove(deviceId);
      return true;
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
    try {
      const now = Date.now();
      await this.localStore.updateLastSeen(deviceId, now);
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
    try {
      const local = await this.localStore.getAll();
      const found = local.find(d => d.deviceId === deviceId);
      return found ? normalizeActiveDevice(found) : null;
    } catch (err: unknown) {
      logger.error('ActiveDeviceCache: failed to get active device', {
        deviceId,
        error: err instanceof Error ? err.message : String(err)
      });
      return null;
    }
  }

  /**
   * Get ALL active devices (local file store — hot path for publish cycles).
   */
  async getAllActive(): Promise<ActiveDevice[]> {
    try {
      return (await this.localStore.getAll()).map(normalizeActiveDevice);
    } catch (err: unknown) {
      logger.error('ActiveDeviceCache: failed to read local active devices', {
        error: err instanceof Error ? err.message : String(err)
      });
      return [];
    }
  }

  /**
   * Clear local active-device file (admin/tests only).
   * Not called on startup — Redis set restore + local persist cover restarts.
   */
  async flushAll(): Promise<number> {
    try {
      const cleared = await this.localStore.clear();
      logger.info('🧹 [LOCAL_ACTIVE_CACHE] Startup flush completed', {
        deletedDevices: cleared,
        file: 'active-devices.json'
      });
      return cleared;
    } catch (err: unknown) {
      logger.error('ActiveDeviceCache: failed to flush local active devices', {
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
    activeDeviceCacheInstance = new ActiveDeviceCache(process.env.DATA_DIR || './data');
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

      //unwanted db calls  are happening here, Since our device registeration topic will send the enough data to this function
      // Prefer lookup by clientId (topic-derived deviceId), then by macID for legacy records
      let existing = await Device.findOne({ clientId: data.clientId });
      if (existing && existing.macID === data.macID && existing.clientId ===data.clientId) {
        // Update existing device
        existing.macID = data.macID;
        existing.lastSeenAt = new Date();
        existing.updatedAt = new Date();

        const appVersion =
          data.metadata?.appVersion || data.metadata?.app_version || data.metadata?.fw_version;
        if (typeof appVersion === 'string' && appVersion.trim()) {
          await DeviceOtaState.updateOne(
            { deviceId: existing.clientId },
            { $set: { firmwareVersion: appVersion.trim(), firmwareReportedAt: new Date() } },
            { upsert: true }
          );
        }
        
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
      const appVersion =
        data.metadata?.appVersion || data.metadata?.app_version || data.metadata?.fw_version;
      const device = new Device({
        businessId: undefined, // Will be set when allocated to a business
        macID: data.macID,
        crt: undefined, // Will be filled during provisioning
        ca_certificate: undefined, // Will be filled during provisioning
        clientId: data.clientId,
        status: initialStatus,
        tokenUsed: false,
        lastSeenAt: new Date()
      });

      await device.save();

      if (typeof appVersion === 'string' && appVersion.trim()) {
        await DeviceOtaState.updateOne(
          { deviceId: device.clientId },
          { $set: { firmwareVersion: appVersion.trim(), firmwareReportedAt: new Date() } },
          { upsert: true }
        );
      }

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
      const device = await withMongoRetry(
        () => Device.findOne({ clientId }),
        { label: 'getDevice' }
      );
      
      if (!device) {
        return null;
      }

      return {
        deviceId: device.clientId,
        username: device.businessId?.toString() || 'unassigned',
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
          username: device.businessId?.toString() || 'unassigned',
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
      await withMongoRetry(async () => {
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
      }, { label: 'updateDeviceStatus' });
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
   * Get devices by business ID
   */
  async getDevicesByBusinessId(businessId: string): Promise<DeviceData[]> {
    try {
      if (!mongoose.Types.ObjectId.isValid(businessId)) {
        return [];
      }

      const devices = await Device.find({
        businessId: new mongoose.Types.ObjectId(businessId)
      });

      return devices.map(device => ({
        deviceId: device.clientId,
        username: device.businessId?.toString() || 'unassigned',
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
      logger.error('Failed to get devices by business', { businessId, error });
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

