import { FileStorage } from './fileStorage';
import { Device } from '../types';
import { logger } from '../utils/logger';

export class DeviceStorage {
  private storage: FileStorage<Device>;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private cleanupIntervalMs: number;

  constructor(dataDir: string, cleanupIntervalSeconds: number = 3600) {
    this.storage = new FileStorage<Device>('devices.json', dataDir);
    this.cleanupIntervalMs = cleanupIntervalSeconds * 1000;
  }

  async initialize(): Promise<void> {
    await this.storage.initialize();
    
    // Start cleanup interval for inactive devices
    this.startCleanup();
    
    logger.info('Device storage initialized', {
      cleanupInterval: `${this.cleanupIntervalMs / 1000}s`
    });
  }

  async registerDevice(device: Device): Promise<void> {
    await this.storage.set(device.deviceId, device);
    logger.info('Device registered', {
      deviceId: device.deviceId,
      clientId: device.clientId,
      username: device.username
    });
  }

  async getDevice(deviceId: string): Promise<Device | null> {
    return await this.storage.get(deviceId);
  }

  async updateDeviceStatus(
    deviceId: string, 
    status: 'active' | 'inactive'
  ): Promise<void> {
    const device = await this.getDevice(deviceId);
    if (device) {
      device.status = status;
      device.lastSeen = new Date().toISOString();
      await this.storage.set(deviceId, device);
      logger.debug('Device status updated', { deviceId, status });
    }
  }

  async updateLastSeen(deviceId: string): Promise<void> {
    const device = await this.getDevice(deviceId);
    if (device) {
      device.lastSeen = new Date().toISOString();
      device.status = 'active';
      await this.storage.set(deviceId, device);
    }
  }

  async getAllDevices(): Promise<Map<string, Device>> {
    return await this.storage.getAll();
  }

  async getDevicesByUsername(username: string): Promise<Device[]> {
    const allDevices = await this.storage.getAll();
    const devices: Device[] = [];
    
    for (const device of allDevices.values()) {
      if (device.username === username) {
        devices.push(device);
      }
    }
    
    return devices;
  }

  async deleteDevice(deviceId: string): Promise<void> {
    await this.storage.delete(deviceId);
    logger.info('Device deleted', { deviceId });
  }

  private startCleanup(): void {
    this.cleanupInterval = setInterval(async () => {
      await this.cleanupInactiveDevices();
    }, this.cleanupIntervalMs);
  }

  private async cleanupInactiveDevices(): Promise<void> {
    const allDevices = await this.storage.getAll();
    const now = new Date().getTime();
    const inactiveThreshold = 24 * 60 * 60 * 1000; // 24 hours
    let cleanedCount = 0;

    for (const [deviceId, device] of allDevices) {
      const lastSeen = new Date(device.lastSeen).getTime();
      if (now - lastSeen > inactiveThreshold && device.status === 'inactive') {
        await this.deleteDevice(deviceId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      logger.info('Cleaned up inactive devices', { count: cleanedCount });
    }
  }

  async close(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    await this.storage.close();
  }
}
