/**
 * Authentication Service
 * Handles JWT token verification for auth_token using AUTH_SECRET
 * Used for validating user authentication in provisioning flow
 */

import * as jwt from 'jsonwebtoken';
import { logger } from '../utils/logger';

export interface AuthTokenPayload {
  sub?: string;        // Subject (user ID) - common in Auth.js
  userId?: string;     // User ID (alternative field)
  id?: string;         // User ID (alternative field)
  user_id?: string;    // User ID (alternative field)
  email?: string;      // User email
  iat?: number;        // Issued at
  exp?: number;         // Expiration
  [key: string]: any;   // Allow other fields
}

export interface AuthTokenVerificationResult {
  valid: boolean;
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
        tokenLength: authToken.length,
        tokenPreview: authToken.substring(0, 30) + '...'
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
        logger.warn('JWT verification failed', {
          error: jwtErrorMessage,
          tokenPreview: authToken.substring(0, 30) + '...'
        });

        // Provide specific error messages
        if (jwtErrorMessage.includes('expired')) {
          return {
            valid: false,
            error: 'auth_token has expired. Please obtain a new token.'
          };
        } else if (jwtErrorMessage.includes('signature')) {
          return {
            valid: false,
            error: 'Invalid auth_token signature. Token may be tampered with or signed with wrong secret.'
          };
        } else if (jwtErrorMessage.includes('malformed')) {
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

      // Extract user ID from token (try multiple common field names)
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
          tokenPreview: authToken.substring(0, 30) + '...'
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
          tokenPreview: authToken.substring(0, 30) + '...'
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
        tokenPreview: authToken ? authToken.substring(0, 30) + '...' : 'null'
      });

      return {
        valid: false,
        error: `Authentication verification failed: ${errorMessage}`
      };
    }
  }
}

