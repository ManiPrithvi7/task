/**
 * MongoDB Service
 * Handles MongoDB connection and provides database access
 * Note: Shared database with Next.js web app (user management handled there)
 */

import mongoose from 'mongoose';
import { logger } from '../utils/logger';

export interface MongoConfig {
  uri: string;
  dbName?: string;
  options?: mongoose.ConnectOptions;
}

export class MongoService {
  private connection: mongoose.Connection | null = null;
  private config: MongoConfig;
  private isConnected: boolean = false;

  constructor(config: MongoConfig) {
    this.config = config;
  }

  /**
   * Connect to MongoDB
   * @returns Promise<void>
   */
  async connect(): Promise<void> {
    try {
      if (this.isConnected) {
        logger.info('MongoDB already connected');
        return;
      }

      // Build connection URI with database name if provided
      let connectionUri = this.config.uri;
      
      // If dbName is provided and not already in URI, append it
      if (this.config.dbName && !connectionUri.includes('/' + this.config.dbName) && !connectionUri.includes('?')) {
        // Check if URI already has a database path
        const uriParts = connectionUri.split('/');
        if (uriParts.length >= 4) {
          // URI already has database path, replace it
          uriParts[uriParts.length - 1] = this.config.dbName;
          connectionUri = uriParts.join('/');
        } else {
          // Append database name
          connectionUri = connectionUri.endsWith('/') 
            ? `${connectionUri}${this.config.dbName}` 
            : `${connectionUri}/${this.config.dbName}`;
        }
      }

      const options: mongoose.ConnectOptions = {
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
        bufferCommands: false,
        ...this.config.options
      };

      // Add dbName to options if not already in URI
      if (this.config.dbName && connectionUri === this.config.uri) {
        options.dbName = this.config.dbName;
      }

      // Log connection attempt (sanitize URI for security)
      const sanitizedUri = this.sanitizeUri(connectionUri);
      logger.info('Attempting MongoDB connection', { 
        uri: sanitizedUri,
        dbName: this.config.dbName || 'default'
      });

      await mongoose.connect(connectionUri, options);
      
      this.connection = mongoose.connection;
      this.isConnected = true;

      this.setupEventHandlers();

      logger.info('MongoDB connected successfully', {
        host: this.connection.host,
        port: this.connection.port,
        name: this.connection.name,
        dbName: this.connection.name
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const sanitizedUri = this.sanitizeUri(this.config.uri);
      logger.error('Failed to connect to MongoDB', { 
        error: errorMessage,
        uri: sanitizedUri,
        dbName: this.config.dbName || 'default'
      });
      throw new Error(`MongoDB connection failed: ${errorMessage}`);
    }
  }

  /**
   * Sanitize MongoDB URI by removing credentials for logging
   * @param uri - MongoDB connection URI
   * @returns Sanitized URI without credentials
   */
  private sanitizeUri(uri: string): string {
    try {
      // Match MongoDB URI pattern: mongodb://[username:password@]host[:port]/database
      // or mongodb+srv://[username:password@]host/database
      const uriRegex = /^(mongodb(?:\+srv)?:\/\/)(?:[^:]+:[^@]+@)?([^\/]+)(\/.*)?$/;
      const match = uri.match(uriRegex);
      
      if (match) {
        const [, protocol, hostPart, pathPart] = match;
        return `${protocol}${hostPart}${pathPart || ''}`;
      }
      return uri.replace(/:[^:@]+@/, '@'); // Fallback: remove password but keep username
    } catch {
      return '[invalid URI]';
    }
  }

  /**
   * Disconnect from MongoDB
   * @returns Promise<void>
   */
  async disconnect(): Promise<void> {
    try {
      if (!this.isConnected) {
        logger.info('MongoDB already disconnected');
        return;
      }

      await mongoose.disconnect();
      this.connection = null;
      this.isConnected = false;

      logger.info('MongoDB disconnected successfully');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to disconnect from MongoDB', { error: errorMessage });
      throw new Error(`MongoDB disconnection failed: ${errorMessage}`);
    }
  }

  /**
   * Check if MongoDB is connected
   * @returns boolean
   */
  isMongoConnected(): boolean {
    return this.isConnected && this.connection?.readyState === 1;
  }

  /**
   * Get MongoDB connection
   * @returns mongoose.Connection | null
   */
  getConnection(): mongoose.Connection | null {
    return this.connection;
  }

  /**
   * Health check for MongoDB connection
   * @returns Promise<boolean>
   */
  async healthCheck(): Promise<boolean> {
    try {
      if (!this.isConnected || !this.connection) {
        return false;
      }

      if (this.connection?.db) {
        await this.connection.db.admin().ping();
      }
      return true;
    } catch (error) {
      logger.error('MongoDB health check failed', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      return false;
    }
  }

  /**
   * Setup MongoDB event handlers
   */
  private setupEventHandlers(): void {
    if (!this.connection) return;

    this.connection.on('connected', () => {
      logger.info('MongoDB connection established');
      this.isConnected = true;
    });

    this.connection.on('error', (error) => {
      logger.error('MongoDB connection error', { error: error.message });
      this.isConnected = false;
    });

    this.connection.on('disconnected', () => {
      logger.warn('MongoDB disconnected');
      this.isConnected = false;
    });

    this.connection.on('reconnected', () => {
      logger.info('MongoDB reconnected');
      this.isConnected = true;
    });

    this.connection.on('close', () => {
      logger.warn('MongoDB connection closed');
      this.isConnected = false;
    });
  }

  /**
   * Get database instance
   * @returns mongoose.Connection.db | null
   */
  getDatabase() {
    return this.connection?.db || null;
  }

  /**
   * Create a new collection (if needed)
   * @param name - Collection name
   * @returns Promise<mongoose.Collection>
   */
  async createCollection(name: string): Promise<any> {
    if (!this.connection) {
      throw new Error('MongoDB not connected');
    }

    if (!this.connection?.db) {
      throw new Error('MongoDB database not available');
    }
    return this.connection.db.createCollection(name);
  }

  /**
   * Drop a collection
   * @param name - Collection name
   * @returns Promise<boolean>
   */
  async dropCollection(name: string): Promise<boolean> {
    if (!this.connection) {
      throw new Error('MongoDB not connected');
    }

    try {
      if (!this.connection?.db) {
        throw new Error('MongoDB database not available');
      }
      await this.connection.db.dropCollection(name);
      return true;
    } catch (error) {
      logger.error('Failed to drop collection', { collection: name, error });
      return false;
    }
  }
}

// Export singleton instance
let mongoService: MongoService | null = null;

export function getMongoService(): MongoService | null {
  return mongoService;
}

export function createMongoService(config: MongoConfig): MongoService {
  mongoService = new MongoService(config);
  return mongoService;
}

