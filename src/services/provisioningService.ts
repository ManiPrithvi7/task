/**
 * Provisioning Service (Lite)
 * Handles JWT token issuance and validation for device provisioning
 * Uses in-memory TokenStore instead of Redis
 */

import * as jwt from 'jsonwebtoken';
import { logger } from '../utils/logger';
import { TokenStore, getTokenStore } from '../storage/tokenStore';

export interface ProvisioningConfig {
  tokenTTL: number;  // Token TTL in seconds (default: 300 = 5 minutes)
  jwtSecret: string;
}

export interface ProvisioningTokenPayload {
  device_id: string;
  user_id: string;  // User ID bound to token at issuance
  type: 'provisioning';
  iat: number;
  exp: number;
}

export interface TokenValidationResult {
  valid: boolean;
  deviceId?: string;
  userId?: string;  // User ID extracted from token payload
  error?: string;
}

export class ProvisioningService {
  private config: ProvisioningConfig;
  private tokenStore: TokenStore;

  constructor(config: ProvisioningConfig) {
    this.config = config;
    this.tokenStore = getTokenStore();
  }

  /**
   * Issue a provisioning token for a device and user
   * Token is single-use, short-lived (5 minutes), and stored in Redis
   * Token binds both device_id and user_id for security
   */
  async issueToken(deviceId: string, userId: string): Promise<string> {
    try {
      logger.debug('Token issuance started', { deviceId, userId });

      // Check if device already has an active token
      const existingToken = await this.tokenStore.getTokenByDevice(deviceId);

      if (existingToken) {
        // Validate existing token
        const validation = await this.validateTokenWithoutRevoke(existingToken);

        if (validation.valid && validation.deviceId === deviceId) {
          try {
            const decoded = jwt.decode(existingToken) as ProvisioningTokenPayload;
            if (decoded && decoded.exp) {
              const expiresAt = new Date(decoded.exp * 1000);
              const now = Date.now();
              const expiresIn = Math.floor((decoded.exp * 1000 - now) / 1000);

              logger.warn('Active provisioning token already exists', {
                deviceId,
                userId,
                expiresAt: expiresAt.toISOString(),
                expiresInSeconds: expiresIn
              });

              const error = new Error('Active provisioning token already exists') as any;
              error.statusCode = 409;
              error.details = {
                message: 'A provisioning token for this device is already active.',
                expiresAt: expiresAt.toISOString(),
                expiresInSeconds: expiresIn > 0 ? expiresIn : 0,
                token: existingToken
              };
              throw error;
            }
          } catch (decodeError: any) {
            if (decodeError instanceof Error && decodeError.message === 'Active provisioning token already exists') {
              throw decodeError;
            }
            // Token invalid, revoke and continue
            await this.revokeToken(existingToken);
          }
        } else {
          // Token invalid, revoke and continue
          await this.revokeToken(existingToken);
        }
      }

      // Create token payload with both device_id and user_id
      const now = Math.floor(Date.now() / 1000);
      const payload: ProvisioningTokenPayload = {
        device_id: deviceId,
        user_id: userId,  // Bind user_id to token at issuance
        type: 'provisioning',
        iat: now,
        exp: now + this.config.tokenTTL
      };

      // Sign token
      const token = jwt.sign(payload, this.config.jwtSecret, {
        algorithm: 'HS256'
      });

      // Store token
      await this.tokenStore.setToken(token, deviceId, this.config.tokenTTL);

      logger.info('Provisioning token issued', {
        deviceId,
        userId,
        tokenTTL: this.config.tokenTTL,
        expiresAt: new Date(payload.exp * 1000).toISOString()
      });

      return token;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to issue provisioning token', { deviceId, userId, error: errorMessage });
      throw error;
    }
  }

  /**
   * Validate a provisioning token without revoking
   * Returns both deviceId and userId from token payload
   */
  async validateTokenWithoutRevoke(token: string): Promise<TokenValidationResult> {
    try {
      // Step 1: Verify JWT signature and expiration FIRST
      // This is the primary validation - JWT library handles expiration
      let decoded: ProvisioningTokenPayload;
      try {
        decoded = jwt.verify(token, this.config.jwtSecret, {
          algorithms: ['HS256']
        }) as ProvisioningTokenPayload;
      } catch (jwtError) {
        const jwtErrorMessage = jwtError instanceof Error ? jwtError.message : 'Unknown JWT error';
        
        // Provide specific error messages for common JWT errors
        if (jwtErrorMessage.includes('expired')) {
          return { valid: false, error: 'Token expired' };
        }
        if (jwtErrorMessage.includes('invalid signature')) {
          return { valid: false, error: 'Invalid token signature' };
        }
        if (jwtErrorMessage.includes('malformed')) {
          return { valid: false, error: 'Invalid token format' };
        }
        
        return { valid: false, error: `Token verification failed: ${jwtErrorMessage}` };
      }

      // Step 2: Validate token type
      if (decoded.type !== 'provisioning') {
        return { valid: false, error: 'Invalid token type' };
      }

      // Step 3: Check JWT expiration explicitly (double-check)
      const now = Math.floor(Date.now() / 1000);
      if (decoded.exp && decoded.exp < now) {
        logger.warn('Token expired (JWT expiration check)', {
          exp: decoded.exp,
          now,
          expiredBy: `${now - decoded.exp} seconds`
        });
        return { valid: false, error: 'Token expired' };
      }

      // Step 4: Check if token exists in store (secondary validation)
      // This helps detect revoked tokens or tokens that were never stored
      let deviceId: string | null = null;
      try {
        deviceId = await this.tokenStore.getDeviceByToken(token);
      } catch (storeError) {
        // Token store error (Redis down, etc.) - but JWT is valid
        // Log warning but allow validation if JWT is valid
        logger.warn('Token store lookup failed, but JWT is valid', {
          error: storeError instanceof Error ? storeError.message : 'Unknown error',
          deviceId: decoded.device_id,
          note: 'Proceeding with JWT validation only'
        });
        // Continue with JWT validation - token store is optional for validation
      }

      // If token not in store but JWT is valid, check if it's a timing issue
      if (!deviceId) {
        const storeStats = await this.tokenStore.getStats();
        // Token might have expired in store but JWT still valid (race condition)
        // Or token store was cleared (server restart, Redis flush)
        logger.warn('Token not found in store, but JWT is valid', {
          deviceId: decoded.device_id,
          exp: decoded.exp,
          expiresIn: decoded.exp ? `${decoded.exp - now} seconds` : 'unknown',
          storage: storeStats.storage,
          tokenCount: storeStats.tokenCount,
          note: 'Token may have been cleared from store (server restart, or in-memory store was reset). Configure Redis for persistence.'
        });

        const hint = storeStats.storage === 'memory'
          ? ' Server is using in-memory token storage; tokens are lost on restart. Call POST /onboarding then POST /sign-csr in the same session without restarting, or set REDIS_URL for persistence.'
          : ' Request a new provisioning token (POST /onboarding), then call sign-csr immediately.';

        return {
          valid: false,
          error: `Token not found in system. Token may have expired or been revoked.${hint}`
        };
      }

      // Step 5: Validate device_id matches between JWT and store
      if (decoded.device_id !== deviceId) {
        logger.error('Device ID mismatch between JWT and token store', {
          jwtDeviceId: decoded.device_id,
          storeDeviceId: deviceId
        });
        return { valid: false, error: 'Device ID mismatch' };
      }

      // Step 6: Extract user_id from token payload
      const userId = decoded.user_id;
      if (!userId) {
        logger.warn('User ID not found in token payload', {
          deviceId,
          tokenPreview: token.substring(0, 30) + '...'
        });
        return { valid: false, error: 'User ID not found in token payload' };
      }

      return { valid: true, deviceId, userId };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStack = error instanceof Error ? error.stack : undefined;
      logger.error('Token validation error', {
        error: errorMessage,
        stack: errorStack
      });
      return { valid: false, error: `Token validation failed: ${errorMessage}` };
    }
  }

  /**
   * Validate a provisioning token
   * Returns both deviceId and userId from token payload
   */
  async validateToken(token: string): Promise<TokenValidationResult> {
    const validation = await this.validateTokenWithoutRevoke(token);

    if (validation.valid) {
      logger.info('Provisioning token validated', { 
        deviceId: validation.deviceId,
        userId: validation.userId
      });
    } else {
      logger.warn('Provisioning token validation failed', { error: validation.error });
    }

    return validation;
  }

  /**
   * Revoke a provisioning token
   */
  async revokeToken(token: string): Promise<void> {
    try {
      const deviceId = await this.tokenStore.getDeviceByToken(token);
      if (deviceId) {
        await this.tokenStore.deleteToken(token);
        logger.info('Provisioning token revoked', { deviceId });
      } else {
        logger.warn('Token not found for revocation');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to revoke provisioning token', { error: errorMessage });
    }
  }

  /**
   * Check if a device has an active provisioning token
   */
  async hasActiveToken(deviceId: string): Promise<boolean> {
    return this.tokenStore.hasActiveToken(deviceId);
  }

  /**
   * Get token TTL from config
   */
  getTokenTTL(): number {
    return this.config.tokenTTL;
  }
}

