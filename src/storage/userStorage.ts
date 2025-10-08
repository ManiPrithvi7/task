import { FileStorage } from './fileStorage';
import { User } from '../types';
import { logger } from '../utils/logger';

export class UserStorage {
  private storage: FileStorage<User>;

  constructor(dataDir: string) {
    this.storage = new FileStorage<User>('users.json', dataDir);
  }

  async initialize(): Promise<void> {
    await this.storage.initialize();
    logger.info('User storage initialized');
  }

  async createUser(user: User): Promise<void> {
    await this.storage.set(user.userId, user);
    logger.info('User created', { userId: user.userId, username: user.username });
  }

  async getUser(userId: string): Promise<User | null> {
    return await this.storage.get(userId);
  }

  async getUserByUsername(username: string): Promise<User | null> {
    const allUsers = await this.storage.getAll();
    for (const user of allUsers.values()) {
      if (user.username === username) {
        return user;
      }
    }
    return null;
  }

  async updateUser(userId: string, updates: Partial<User>): Promise<boolean> {
    const user = await this.storage.get(userId);
    if (!user) {
      return false;
    }

    const updatedUser = { ...user, ...updates };
    await this.storage.set(userId, updatedUser);
    logger.info('User updated', { userId });
    return true;
  }

  async addDeviceToUser(userId: string, deviceId: string): Promise<boolean> {
    const user = await this.storage.get(userId);
    if (!user) {
      return false;
    }

    if (!user.devices.includes(deviceId)) {
      user.devices.push(deviceId);
      await this.storage.set(userId, user);
      logger.info('Device added to user', { userId, deviceId });
    }
    
    return true;
  }

  async removeDeviceFromUser(userId: string, deviceId: string): Promise<boolean> {
    const user = await this.storage.get(userId);
    if (!user) {
      return false;
    }

    user.devices = user.devices.filter(d => d !== deviceId);
    await this.storage.set(userId, user);
    logger.info('Device removed from user', { userId, deviceId });
    return true;
  }

  async getAllUsers(): Promise<Map<string, User>> {
    return await this.storage.getAll();
  }

  async deleteUser(userId: string): Promise<void> {
    await this.storage.delete(userId);
    logger.info('User deleted', { userId });
  }

  async close(): Promise<void> {
    await this.storage.close();
  }
}
