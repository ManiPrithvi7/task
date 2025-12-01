/**
 * User Service for verifying user existence and device-user associations
 * Uses MongoDB with Mongoose for real data access
 */

import { MongoService } from './mongoService';
import { Device, User, IUser, IDevice } from '../models';
import { logger } from '../utils/logger';
import mongoose from 'mongoose';

export interface UserVerificationResult {
  found: boolean;
  user?: IUser;
  error?: string;
}

export interface DeviceVerificationResult {
  found: boolean;
  device?: IDevice;
  error?: string;
  isAssociated: boolean;
}

export class UserService {
  private mongoService: MongoService | null = null;
  private isConnected: boolean = false;

  constructor(mongoService: MongoService) {
    this.mongoService = mongoService;
  }

  /**
   * Initialize MongoDB connection
   * @returns Promise<void>
   */
  async initialize(): Promise<void> {
    try {
      if (!this.mongoService) {
        throw new Error('MongoDB service not provided');
      }

      await this.mongoService.connect();
      this.isConnected = true;
      logger.info('UserService initialized with MongoDB connection');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to initialize UserService', { error: errorMessage });
      throw new Error(`UserService initialization failed: ${errorMessage}`);
    }
  }

  /**
   * Check if MongoDB is connected
   * @returns boolean
   */
  isMongoConnected(): boolean {
    return this.isConnected && this.mongoService?.isMongoConnected() === true;
  }

  /**
   * Verify user exists in database
   * @param userId - MongoDB ObjectId of user
   * @returns User document if exists, null otherwise
   */
  async verifyUserExists(userId: mongoose.Types.ObjectId): Promise<UserVerificationResult> {
    try {
      if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
        return {
          found: false,
          error: 'Invalid user ID format. Expected MongoDB ObjectId.'
        };
      }

      // Check MongoDB connection using UserService's connection check
      if (!this.isMongoConnected()) {
        const connectionState = mongoose.connection.readyState;
        logger.warn('MongoDB not connected via UserService', {
          readyState: connectionState,
          readyStateText: connectionState === 0 ? 'disconnected' : 
                          connectionState === 1 ? 'connected' : 
                          connectionState === 2 ? 'connecting' : 'disconnecting',
          isConnected: this.isConnected,
          hasMongoService: !!this.mongoService,
          userId: userId.toString()
        });
        
        // Try to ensure connection is established
        if (this.mongoService && !this.mongoService.isMongoConnected()) {
          logger.info('Attempting to reconnect MongoDB...');
          try {
            await this.mongoService.connect();
            if (!this.mongoService.isMongoConnected()) {
              return {
                found: false,
                error: 'MongoDB connection failed. Please check database configuration.'
              };
            }
          } catch (connectError) {
            logger.error('Failed to reconnect MongoDB', {
              error: connectError instanceof Error ? connectError.message : 'Unknown error'
            });
            return {
              found: false,
              error: `MongoDB connection error: ${connectError instanceof Error ? connectError.message : 'Unknown error'}`
            };
          }
        } else {
          return {
            found: false,
            error: 'MongoDB connection not ready'
          };
        }
      }

      // Get connection info for logging
      const connectionState = mongoose.connection.readyState;
      const connectionName = mongoose.connection.name;
      const connectionHost = mongoose.connection.host;
      const connectionPort = mongoose.connection.port;
      
      logger.debug('MongoDB connection verified', {
        readyState: connectionState,
        readyStateText: connectionState === 1 ? 'connected' : 'other',
        dbName: connectionName,
        host: connectionHost,
        port: connectionPort,
        userId: userId.toString()
      });

      logger.debug('Verifying user exists', {
        userId: userId.toString(),
        dbName: connectionName,
        collection: 'User', // Prisma uses capitalized collection name
        host: connectionHost
      });

      // Test query to verify collection access
      try {
        const testCount = await User.countDocuments({});
        logger.debug('User collection accessible', {
          totalUsers: testCount,
          dbName: connectionName,
          collection: 'User'
        });
      } catch (testError) {
        logger.error('Failed to access User collection', {
          error: testError instanceof Error ? testError.message : 'Unknown error',
          dbName: connectionName,
          collection: 'User'
        });
      }

      // Query user using Mongoose model
      const user = await User.findById(userId);

      if (!user) {
        logger.warn('User not found in database', {
          userId: userId.toString(),
          dbName: connectionName,
          collection: 'User',
          host: connectionHost
        });
        
        // Additional diagnostic: Try to find user by email or other field
        try {
          const allUsers = await User.find({}).limit(5).select('_id email name');
          logger.debug('Sample users in database', {
            sampleCount: allUsers.length,
            sampleUsers: allUsers.map(u => ({
              id: u._id.toString(),
              email: u.email,
              name: u.name
            }))
          });
        } catch (diagError) {
          logger.error('Failed to query sample users', {
            error: diagError instanceof Error ? diagError.message : 'Unknown error'
          });
        }
        
        return {
          found: false,
          error: 'User not found in database'
        };
      }

      logger.info('User verified successfully', {
        userId: user._id.toString(),
        email: user.email,
        name: user.name
      });

      return {
        found: true,
        user
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to verify user existence', {
        userId: userId?.toString(),
        error: errorMessage
      });

      return {
        found: false,
        error: `Database error: ${errorMessage}`
      };
    }
  }

  /**
   * Verify device is associated with user
   * @param deviceId - Device identifier (clientId or macID from provisioning token)
   * @param userId - MongoDB ObjectId of user
   * @returns Device document if associated, null otherwise
   */
  async verifyDeviceUserAssociation(
    deviceId: string,
    userId: mongoose.Types.ObjectId
  ): Promise<DeviceVerificationResult> {
    try {
      if (!deviceId || typeof deviceId !== 'string' || deviceId.trim().length === 0) {
        return {
          found: false,
          isAssociated: false,
          error: 'Invalid device ID. Device ID must be a non-empty string.'
        };
      }

      if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
        return {
          found: false,
          isAssociated: false,
          error: 'Invalid user ID format. Expected MongoDB ObjectId.'
        };
      }

      // Check MongoDB connection
      if (!this.isMongoConnected()) {
        logger.warn('MongoDB not connected for device verification', {
          deviceId,
          userId: userId.toString()
        });
        
        // Try to ensure connection is established
        if (this.mongoService && !this.mongoService.isMongoConnected()) {
          try {
            await this.mongoService.connect();
            if (!this.mongoService.isMongoConnected()) {
              return {
                found: false,
                isAssociated: false,
                error: 'MongoDB connection failed'
              };
            }
          } catch (connectError) {
            return {
              found: false,
              isAssociated: false,
              error: `MongoDB connection error: ${connectError instanceof Error ? connectError.message : 'Unknown error'}`
            };
          }
        } else {
          return {
            found: false,
            isAssociated: false,
            error: 'MongoDB connection not ready'
          };
        }
      }

      logger.debug('Verifying device-user association', {
        deviceId,
        userId: userId.toString()
      });

      // Try to find device by clientId first (most common)
      let device = await Device.findOne({ clientId: deviceId });

      // If not found by clientId, try macID
      if (!device) {
        device = await Device.findOne({ macID: deviceId });
      }

      if (!device) {
        logger.warn('Device not found in database', {
          deviceId,
          userId: userId.toString()
        });
        return {
          found: false,
          isAssociated: false,
          error: `Device not found for device_id: ${deviceId}`
        };
      }

      // Verify device belongs to the user
      const deviceUserId = device.userId?.toString();
      const requestedUserId = userId.toString();

      if (!deviceUserId || deviceUserId !== requestedUserId) {
        logger.warn('Device is not associated with the requested user', {
          deviceId,
          deviceUserId: deviceUserId || 'null',
          requestedUserId
        });
        return {
          found: true,
          device,
          isAssociated: false,
          error: 'Device is not associated with the authenticated user'
        };
      }

      logger.info('Device-user association verified successfully', {
        deviceId,
        userId: userId.toString(),
        clientId: device.clientId,
        macID: device.macID
      });

      return {
        found: true,
        device,
        isAssociated: true
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to verify device-user association', {
        deviceId,
        userId: userId?.toString(),
        error: errorMessage
      });

      return {
        found: false,
        isAssociated: false,
        error: `Database error: ${errorMessage}`
      };
    }
  }

  /**
   * Disconnect from MongoDB
   * @returns Promise<void>
   */
  async disconnect(): Promise<void> {
    try {
      if (this.mongoService) {
        await this.mongoService.disconnect();
        this.isConnected = false;
        logger.info('UserService disconnected from MongoDB');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to disconnect UserService', { error: errorMessage });
    }
  }
}

