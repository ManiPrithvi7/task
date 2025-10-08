import fs from 'fs/promises';
import path from 'path';
import { logger } from '../utils/logger';

/**
 * Generic file-based storage with automatic persistence
 */
export class FileStorage<T> {
  private filePath: string;
  private data: Map<string, T>;
  private saveTimer: NodeJS.Timeout | null = null;
  private expirationTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(filename: string, dataDir: string = './data') {
    this.filePath = path.join(dataDir, filename);
    this.data = new Map();
  }

  async initialize(): Promise<void> {
    try {
      // Create data directory if not exists
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      
      // Try to load existing data
      try {
        const content = await fs.readFile(this.filePath, 'utf-8');
        const parsed = JSON.parse(content);
        this.data = new Map(Object.entries(parsed));
        logger.info(`Loaded data from ${path.basename(this.filePath)}`, { 
          count: this.data.size 
        });
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          // File doesn't exist, create empty
          await this.save();
          logger.info(`Created new data file: ${path.basename(this.filePath)}`);
        } else {
          throw error;
        }
      }
    } catch (error: any) {
      logger.error(`Error initializing storage`, { 
        file: path.basename(this.filePath),
        error: error.message 
      });
      throw error;
    }
  }

  async set(key: string, value: T, ttl?: number): Promise<void> {
    // Cancel existing expiration timer if any
    const existingTimer = this.expirationTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Set the value
    this.data.set(key, value);
    
    // Schedule save (debounced)
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 5000);
    
    // Handle TTL expiration
    if (ttl && ttl > 0) {
      const timer = setTimeout(() => {
        this.delete(key);
        logger.debug(`Expired key: ${key}`, { ttl });
      }, ttl * 1000);
      this.expirationTimers.set(key, timer);
    }
  }

  async get(key: string): Promise<T | null> {
    return this.data.get(key) || null;
  }

  async delete(key: string): Promise<void> {
    // Cancel expiration timer if exists
    const timer = this.expirationTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.expirationTimers.delete(key);
    }

    this.data.delete(key);
    await this.save();
  }

  async getAll(): Promise<Map<string, T>> {
    return new Map(this.data);
  }

  async getAllKeys(): Promise<string[]> {
    return Array.from(this.data.keys());
  }

  async has(key: string): Promise<boolean> {
    return this.data.has(key);
  }

  async size(): Promise<number> {
    return this.data.size;
  }

  async clear(): Promise<void> {
    // Clear all expiration timers
    for (const timer of this.expirationTimers.values()) {
      clearTimeout(timer);
    }
    this.expirationTimers.clear();

    this.data.clear();
    await this.save();
  }

  private async save(): Promise<void> {
    try {
      const obj = Object.fromEntries(this.data);
      await fs.writeFile(
        this.filePath, 
        JSON.stringify(obj, null, 2),
        'utf-8'
      );
      logger.debug(`Saved data to ${path.basename(this.filePath)}`, { 
        count: this.data.size 
      });
    } catch (error: any) {
      logger.error(`Error saving data`, { 
        file: path.basename(this.filePath),
        error: error.message 
      });
    }
  }

  async close(): Promise<void> {
    // Clear save timer
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }

    // Clear all expiration timers
    for (const timer of this.expirationTimers.values()) {
      clearTimeout(timer);
    }
    this.expirationTimers.clear();

    // Final save
    await this.save();
    logger.info(`Closed storage: ${path.basename(this.filePath)}`);
  }
}
