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
  type: 'provisioning';
  iat: number;
  exp: number;
}

export interface TokenValidationResult {
  valid: boolean;
  deviceId?: string;
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
   * Issue a provisioning token for a device
   */
  async issueToken(deviceId: string): Promise<string> {
    try {
      logger.debug('Token issuance started', { deviceId });

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

      // Create token payload
      const now = Math.floor(Date.now() / 1000);
      const payload: ProvisioningTokenPayload = {
        device_id: deviceId,
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
        tokenTTL: this.config.tokenTTL,
        expiresAt: new Date(payload.exp * 1000).toISOString()
      });

      return token;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to issue provisioning token', { deviceId, error: errorMessage });
      throw error;
    }
  }

  /**
   * Validate a provisioning token without revoking
   */
  async validateTokenWithoutRevoke(token: string): Promise<TokenValidationResult> {
    try {
      // Verify JWT signature and expiration
      let decoded: ProvisioningTokenPayload;
      try {
        decoded = jwt.verify(token, this.config.jwtSecret, {
          algorithms: ['HS256']
        }) as ProvisioningTokenPayload;
      } catch (jwtError) {
        const jwtErrorMessage = jwtError instanceof Error ? jwtError.message : 'Unknown JWT error';
        return { valid: false, error: `Token verification failed: ${jwtErrorMessage}` };
      }

      // Validate token type
      if (decoded.type !== 'provisioning') {
        return { valid: false, error: 'Invalid token type' };
      }

      // Check if token exists in store
      const deviceId = await this.tokenStore.getDeviceByToken(token);

      if (!deviceId) {
        const now = Math.floor(Date.now() / 1000);
        if (decoded.exp && decoded.exp < now) {
          return { valid: false, error: 'Token expired' };
        }
        return { valid: false, error: 'Token not found in system' };
      }

      // Validate device_id matches
      if (decoded.device_id !== deviceId) {
        return { valid: false, error: 'Device ID mismatch' };
      }

      return { valid: true, deviceId };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { valid: false, error: errorMessage };
    }
  }

  /**
   * Validate a provisioning token
   */
  async validateToken(token: string): Promise<TokenValidationResult> {
    const validation = await this.validateTokenWithoutRevoke(token);

    if (validation.valid) {
      logger.info('Provisioning token validated', { deviceId: validation.deviceId });
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

