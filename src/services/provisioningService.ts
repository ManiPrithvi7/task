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
  /**
   * Per-device mutex to prevent TOCTOU token issuance races.
   * Ensures only one `issueToken(deviceId, ...)` runs at a time for a given deviceId.
   */
  private issueTokenMutex: Map<string, { locked: boolean; queue: Array<() => void> }> = new Map();

  constructor(config: ProvisioningConfig) {
    this.config = config;
    this.tokenStore = getTokenStore();
  }

  private async withIssueTokenLock<T>(deviceId: string, fn: () => Promise<T>): Promise<T> {
    const state =
      this.issueTokenMutex.get(deviceId) ?? { locked: false, queue: [] as Array<() => void> };
    this.issueTokenMutex.set(deviceId, state);

    if (state.locked) {
      await new Promise<void>((resolve) => state.queue.push(resolve));
    }

    state.locked = true;
    try {
      return await fn();
    } finally {
      const next = state.queue.shift();
      if (next) {
        next();
      } else {
        state.locked = false;
        // avoid unbounded growth for device IDs that churn
        this.issueTokenMutex.delete(deviceId);
      }
    }
  }

  /**
   * Issue a provisioning token for a device and user
   * Token is single-use, short-lived (5 minutes), and stored in Redis
   * Token binds both device_id and user_id for security
   */
  async issueToken(deviceId: string, userId: string): Promise<string> {
    return this.withIssueTokenLock(deviceId, async () => {
      try {
      logger.debug('Token issuance started', { deviceId, userId });

      // Check if device already has an active token
      const existingToken = await this.tokenStore.getTokenByDevice(deviceId);

      if (existingToken) {
        // Validate existing token
        const validation = await this.validateTokenWithoutRevoke(existingToken, { allowConsumed: false });

        if (validation.valid && validation.deviceId === deviceId) {
          // If we already have an active, valid token, return a 409 so caller can decide whether to reuse.
          // Decode is best-effort to provide expiry info; unexpected errors must be logged.
          const decoded = jwt.decode(existingToken) as ProvisioningTokenPayload | null;
          if (decoded && typeof decoded.exp === 'number') {
            const expiresAt = new Date(decoded.exp * 1000);
            const nowMs = Date.now();
            const expiresIn = Math.floor((decoded.exp * 1000 - nowMs) / 1000);

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
          } else {
            // If we can't decode expiry, treat it as suspect and revoke it so we can issue a fresh token.
            logger.warn('Active token exists but expiry could not be decoded; revoking and re-issuing', {
              deviceId,
              userId
            });
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
    });
  }

  private async isConsumed(token: string): Promise<boolean> {
    try {
      return await this.tokenStore.isTokenConsumed(token);
    } catch (e) {
      logger.warn('Consumed marker lookup failed (treating as not consumed)', {
        error: e instanceof Error ? e.message : e
      });
      return false;
    }
  }

  /**
   * Validate a provisioning token without revoking
   * Returns both deviceId and userId from token payload
   */
  async validateTokenWithoutRevoke(
    token: string,
    options?: { allowConsumed?: boolean; allowMissingInStore?: boolean }
  ): Promise<TokenValidationResult> {
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
        const now = Math.floor(Date.now() / 1000);

        // Provide specific error messages for common JWT errors
        if (jwtErrorMessage.includes('expired')) {
          try {
            const decoded = jwt.decode(token) as ProvisioningTokenPayload | null;
            if (decoded?.iat != null && decoded?.exp != null) {
              const issuedAt = new Date(decoded.iat * 1000).toISOString();
              const expiresAt = new Date(decoded.exp * 1000).toISOString();
              logger.warn('Token expired (JWT)', {
                iat: decoded.iat,
                exp: decoded.exp,
                now,
                issuedAt,
                expiresAt,
                tokenTTLSeconds: decoded.exp - decoded.iat,
                expiredBySeconds: now - decoded.exp
              });
            }
          } catch (_) { /* ignore decode errors */ }
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
        const issuedAt = decoded.iat != null ? new Date(decoded.iat * 1000).toISOString() : 'unknown';
        const expiresAt = new Date(decoded.exp * 1000).toISOString();
        logger.warn('Token expired (JWT expiration check)', {
          iat: decoded.iat,
          exp: decoded.exp,
          now,
          issuedAt,
          expiresAt,
          tokenTTLSeconds: decoded.iat != null ? decoded.exp - decoded.iat : undefined,
          expiredBySeconds: now - decoded.exp
        });
        return { valid: false, error: 'Token expired' };
      }

      // Step 3a: Explicit consumed marker after successful sign-csr (JWT may still be valid)
      const consumed = await this.isConsumed(token);
      if (consumed && !options?.allowConsumed) {
        return {
          valid: false,
          error:
            'Provisioning token was already used after successful certificate issuance (sign-csr). Tokens are one-time use. Request a new token from POST /api/v1/onboarding.'
        };
      }

      // Step 4: Check if token exists in store (secondary validation)
      // When store is unavailable (Redis down, etc.), we do NOT accept JWT-only for sign-csr,
      // because one-time-use guarantees depend on store-backed consumed markers and mapping.
      let deviceId: string | null = null;
      try {
        deviceId = await this.tokenStore.getDeviceByToken(token);
      } catch (storeError) {
        const msg = storeError instanceof Error ? storeError.message : 'Unknown error';
        logger.error('Token store lookup failed', { error: msg, deviceId: decoded.device_id });
        return {
          valid: false,
          error:
            'Token store unavailable. Please retry. If this persists, ensure Redis is configured for provisioning token persistence.'
        };
      }

      // If token not in store but JWT is valid (and store did not throw): already used or store cleared
      if (!deviceId) {
        // For download flows we may deliberately allow missing-in-store tokens (e.g., consumed tokens are deleted).
        if (options?.allowMissingInStore || consumed) {
          const userId = decoded.user_id;
          if (!userId) {
            return { valid: false, error: 'User ID not found in token payload' };
          }
          return { valid: true, deviceId: decoded.device_id, userId };
        }

        const storeStats = await this.tokenStore.getStats();
        logger.warn('Token not found in store, but JWT is valid (one-time use or store cleared)', {
          deviceId: decoded.device_id,
          exp: decoded.exp,
          expiresIn: decoded.exp ? `${decoded.exp - now} seconds` : 'unknown',
          storage: storeStats.storage,
          tokenCount: storeStats.tokenCount
        });

        const oneTimeUseMessage =
          'Provisioning tokens are one-time use. This token was already used (e.g. after a successful sign-csr) or is no longer in the system. Request a new token from POST /onboarding, then call POST /sign-csr once.';
        const hint =
          storeStats.storage === 'memory'
            ? ` ${oneTimeUseMessage} If you did not call sign-csr yet, the server may have restarted (in-memory store was reset). Configure Redis for persistence.`
            : ` ${oneTimeUseMessage}`;

        return {
          valid: false,
          error: `Token not found in system.${hint}`
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
   * Read-only validation (no side effects).
   * Named explicitly to avoid implying token revocation/consumption.
   */
  async peekToken(token: string): Promise<TokenValidationResult> {
    const validation = await this.validateTokenWithoutRevoke(token, { allowConsumed: false });

    if (validation.valid) {
      logger.info('Provisioning token peeked (read-only)', {
        deviceId: validation.deviceId,
        userId: validation.userId
      });
    } else {
      logger.warn('Provisioning token peek failed', { error: validation.error });
    }

    return validation;
  }

  /**
   * Token validation for certificate download.
   * Allows tokens that were already consumed by sign-csr, because download is a non-mutating follow-up.
   */
  async peekTokenForDownload(token: string): Promise<TokenValidationResult> {
    return this.validateTokenWithoutRevoke(token, { allowConsumed: true, allowMissingInStore: true });
  }

  /**
   * Revoke a provisioning token (cleanup only; does not set consumed marker)
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
   * After successful sign-csr: remove active token and record consumption until JWT exp
   * so repeat requests get TOKEN_ALREADY_USED instead of ambiguous "not in store".
   */
  async finalizeTokenAfterSuccessfulSignCsr(token: string): Promise<void> {
    let ttlSeconds = this.config.tokenTTL;
    try {
      const decoded = jwt.decode(token) as ProvisioningTokenPayload | null;
      if (decoded?.exp) {
        ttlSeconds = Math.max(1, decoded.exp - Math.floor(Date.now() / 1000));
      }
    } catch {
      /* keep default */
    }
    await this.tokenStore.markTokenConsumed(token, ttlSeconds);
    logger.info('Provisioning token finalized after sign-csr (consumed marker set)', {
      ttlSecondsRemaining: ttlSeconds
    });
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

