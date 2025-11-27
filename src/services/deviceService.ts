/**
 * Device Service - MongoDB-based device management
 * Replaces file-based DeviceStorage
 * Updated to match Prisma schema
 */

import { Device, IDevice, DeviceStatus } from '../models/Device';
import { logger } from '../utils/logger';
import mongoose from 'mongoose';

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
      // Check if device exists
      const existing = await Device.findOne({ clientId: data.clientId });

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

      // Create new device
      const device = new Device({
        userId: undefined, // Will be set when allocated to user
        macID: data.macID,
        crt: undefined, // Will be filled during provisioning
        ca_certificate: undefined, // Will be filled during provisioning
        clientId: data.clientId,
        status: DeviceStatus.UNALLOCATED, // Start as unallocated
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

