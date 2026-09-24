/**
 * Authentication Service
 * Handles JWT token verification for auth_token using AUTH_SECRET
 * Used for validating user authentication in provisioning flow
 */

import * as jwt from 'jsonwebtoken';
import { logger } from '../utils/logger';

export interface AuthTokenPayload {
  /** Subject — Business id (dashboard JWT still names this userId/sub). */
  sub?: string;
  /** Business id (legacy claim name). */
  userId?: string;
  id?: string;
  user_id?: string;
  email?: string;      // User email
  /** Dashboard/admin claim. Absent on ordinary business tokens. */
  role?: string;
  iat?: number;        // Issued at
  exp?: number;         // Expiration
}

export interface AuthTokenVerificationResult {
  valid: boolean;
  /** Business id from JWT `sub`/`userId` (endpoint still calls this userId). */
  userId?: string;
  userEmail?: string | undefined;
  error?: string;
  decoded?: AuthTokenPayload;
}

export class AuthService {
  private authSecret: string;

  constructor(authSecret: string) {
    this.authSecret = authSecret;
    
    if (!authSecret || authSecret.trim().length === 0) {
      logger.warn('AUTH_SECRET is empty or not set. Authentication will fail.');
    }
  }

  /**
   * Verify and decode auth_token JWT
   * @param authToken - JWT token from request payload
   * @returns Verification result with user information
   */
  async verifyAuthToken(authToken: string): Promise<AuthTokenVerificationResult> {
    try {
      if (!authToken || typeof authToken !== 'string' || authToken.trim().length === 0) {
        return {
          valid: false,
          error: 'auth_token is required and must be a non-empty string'
        };
      }

      logger.debug('Verifying auth_token', {
        tokenLength: authToken.length
      });

      // Verify JWT signature and expiration
      let decoded: AuthTokenPayload;
      try {
        decoded = jwt.verify(authToken, this.authSecret, {
          algorithms: ['HS256']
        }) as AuthTokenPayload;

        logger.debug('JWT verification successful', {
          hasSub: !!decoded.sub,
          hasUserId: !!decoded.userId,
          hasId: !!decoded.id,
          hasUser_id: !!decoded.user_id,
          email: decoded.email,
          exp: decoded.exp,
          expiresAt: decoded.exp ? new Date(decoded.exp * 1000).toISOString() : null
        });
      } catch (jwtError) {
        const jwtErrorMessage = jwtError instanceof Error ? jwtError.message : 'Unknown JWT error';
        const jwtErrorName = jwtError instanceof Error ? jwtError.name : '';
        logger.warn('JWT verification failed', {
          error: jwtErrorMessage,
          errorName: jwtErrorName,
          tokenLength: authToken.length
        });

        // TokenExpiredError and NotBeforeError subclass JsonWebTokenError, so match name first.
        // Signature and malformed tokens share JsonWebTokenError; those two messages are exact library strings.
        if (jwtErrorName === 'TokenExpiredError') {
          return {
            valid: false,
            error: 'auth_token has expired. Please obtain a new token.'
          };
        }
        if (jwtErrorName === 'NotBeforeError') {
          return {
            valid: false,
            error: 'auth_token is not yet valid.'
          };
        }
        if (jwtErrorName === 'JsonWebTokenError' && jwtErrorMessage === 'invalid signature') {
          return {
            valid: false,
            error: 'Invalid auth_token signature. Token may be tampered with or signed with wrong secret.'
          };
        }
        if (jwtErrorName === 'JsonWebTokenError' && jwtErrorMessage === 'jwt malformed') {
          return {
            valid: false,
            error: 'Malformed auth_token. Token format is invalid.'
          };
        }

        return {
          valid: false,
          error: `Token verification failed: ${jwtErrorMessage}`
        };
      }

      // Extract business id from token (JWT still uses userId/sub)
      let userId: string | undefined;
      if (decoded.sub) {
        userId = decoded.sub;
      } else if (decoded.userId) {
        userId = decoded.userId;
      } else if (decoded.id) {
        userId = decoded.id;
      } else if (decoded.user_id) {
        userId = decoded.user_id;
      }

      if (!userId) {
        logger.warn('User ID not found in auth_token payload', {
          payloadKeys: Object.keys(decoded),
          tokenLength: authToken.length
        });
        return {
          valid: false,
          error: 'User ID not found in auth_token. Token must contain sub, userId, id, or user_id field.',
          decoded
        };
      }

      // Validate user ID format (should be MongoDB ObjectId string)
      if (!userId.match(/^[0-9a-fA-F]{24}$/)) {
        logger.warn('Invalid user ID format in auth_token', {
          userId,
          tokenLength: authToken.length
        });
        return {
          valid: false,
          error: 'Invalid user ID format in auth_token. Expected MongoDB ObjectId format.',
          decoded
        };
      }

      logger.info('Auth token verified successfully', {
        userId,
        email: decoded.email,
        expiresAt: decoded.exp ? new Date(decoded.exp * 1000).toISOString() : null
      });

      return {
        valid: true,
        userId,
        userEmail: decoded.email || undefined,
        decoded
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to verify auth_token', {
        error: errorMessage,
        tokenLength: typeof authToken === 'string' ? authToken.length : 0
      });

      return {
        valid: false,
        error: `Authentication verification failed: ${errorMessage}`
      };
    }
  }
}

