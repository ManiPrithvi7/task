/**
 * Provisioning Routes (Lite)
 * Handles device provisioning endpoints:
 * - POST /api/v1/onboarding - Token issuance
 * - POST /api/v1/sign-csr - CSR signing
 * - GET /api/v1/certificates/:id/download - Certificate download
 * - GET /api/v1/certificates/:deviceId/status - Certificate status
 * - DELETE /api/v1/certificates/:deviceId - Revoke certificate
 */

import { Router, Request, Response } from 'express';
import { logger } from '../utils/logger';
import { ProvisioningService } from '../services/provisioningService';
import { CAService, UnsupportedCSRKeyTypeError, DeviceAlreadyHasCertificateError } from '../services/caService';
import { AuthService } from '../services/authService';
import { UserService } from '../services/userService';
import { DeviceCertificateStatus } from '../models/DeviceCertificate';
import { provisioningRateLimiter, csrRateLimiter } from '../middleware/rateLimiter';
import mongoose from 'mongoose';

export interface ProvisioningDependencies {
  provisioningService: ProvisioningService;
  caService: CAService;
  authService: AuthService;
  userService: UserService;
}

/** Map token validation error message to a stable code for firmware/client handling. */
function getTokenErrorCode(errorMessage: string): string {
  if (errorMessage.includes('Token expired')) return 'TOKEN_EXPIRED';
  if (errorMessage.includes('already used') || errorMessage.includes('one-time use')) return 'TOKEN_ALREADY_USED';
  if (errorMessage.includes('Token not found') || errorMessage.includes('revoked')) return 'TOKEN_NOT_FOUND';
  if (errorMessage.includes('invalid signature')) return 'TOKEN_INVALID_SIGNATURE';
  if (errorMessage.includes('Invalid token format') || errorMessage.includes('malformed')) return 'TOKEN_INVALID_FORMAT';
  if (errorMessage.includes('Invalid token type')) return 'TOKEN_INVALID_TYPE';
  if (errorMessage.includes('Device ID mismatch')) return 'TOKEN_DEVICE_MISMATCH';
  if (errorMessage.includes('User ID not found')) return 'TOKEN_USER_MISSING';
  if (errorMessage.includes('Token verification failed') || errorMessage.includes('Token validation failed')) return 'TOKEN_INVALID';
  return 'TOKEN_INVALID';
}

export function createProvisioningRoutes(dependencies: ProvisioningDependencies): Router {
  const router = Router();
  const { provisioningService, caService, authService, userService } = dependencies;

  // Tier 2: Provisioning rate limiter — applies to ALL routes in this router
  router.use(provisioningRateLimiter());

  /**
   * POST /api/v1/onboarding
   * Stage 1: Token Issuance
   * Validates device_id and auth_token, then issues a provisioning token bound to both device and user
   * 
   * Headers:
   *   Authorization: Bearer <auth_token> (REQUIRED)
   * 
   * Body:
   *   { "device_id": "device-123" }
   */
  router.post('/onboarding', async (req: Request, res: Response): Promise<void> => {
    // Keep key request context available for catch-path retries
    let userId: string | undefined;
    let trimmedDeviceId: string | undefined;
    try {
      logger.debug('Onboarding request received', {
        method: req.method,
        url: req.url,
        hasBody: !!req.body,
        hasAuthHeader: !!req.headers.authorization,
        ip: req.ip
      });

      if (!provisioningService) {
        logger.error('Onboarding: ProvisioningService not available');
        res.status(503).json({
          success: false,
          error: 'Provisioning service is temporarily unavailable. Please try again later.',
          code: 'SERVICE_UNAVAILABLE',
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Extract and validate auth_token from Authorization header
      const authHeader = req.headers.authorization;
      let authToken: string | undefined;

      if (authHeader && authHeader.startsWith('Bearer ')) {
        authToken = authHeader.substring(7);
      }

      if (!authToken || typeof authToken !== 'string' || authToken.trim().length === 0) {
        logger.warn('Onboarding: no auth_token provided', { hasAuthHeader: !!authHeader });
        res.status(401).json({
          success: false,
          error: 'Authentication required. Send a valid auth token in the Authorization header as: Bearer <auth_token>.',
          code: 'AUTH_TOKEN_MISSING',
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Verify auth_token using AuthService
      if (!authService) {
        logger.error('Onboarding: AuthService not available');
        res.status(503).json({
          success: false,
          error: 'Authentication service is temporarily unavailable. Please try again later.',
          code: 'SERVICE_UNAVAILABLE',
          timestamp: new Date().toISOString()
        });
        return;
      }

      logger.debug('Verifying auth_token', {
        authTokenLength: authToken.length,
        authTokenPreview: authToken.substring(0, 30) + '...'
      });

      const authTokenVerification = await authService.verifyAuthToken(authToken);

      logger.debug('Auth token verification result', {
        valid: authTokenVerification.valid,
        userId: authTokenVerification.userId,
        error: authTokenVerification.error
      });

      if (!authTokenVerification.valid || !authTokenVerification.userId) {
        logger.warn('Onboarding: auth token validation failed', { error: authTokenVerification.error });
        res.status(401).json({
          success: false,
          error: authTokenVerification.error || 'The auth token is invalid or expired. Sign in again to get a new token.',
          code: 'AUTH_TOKEN_INVALID',
          timestamp: new Date().toISOString()
        });
        return;
      }

      userId = authTokenVerification.userId;

      // Verify user exists in database
      if (!userService) {
        logger.error('Onboarding: UserService not available');
        res.status(503).json({
          success: false,
          error: 'User verification service is temporarily unavailable. Please try again later.',
          code: 'SERVICE_UNAVAILABLE',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const userIdObjectId = new mongoose.Types.ObjectId(userId);
      const userVerification = await userService.verifyUserExists(userIdObjectId);

      if (!userVerification.found || !userVerification.user) {
        const isConnectionError = userVerification.error?.includes('MongoDB connection') ||
                                  userVerification.error?.includes('connection');

        if (isConnectionError) {
          logger.error('Onboarding: database error during user verification', { userId, error: userVerification.error });
          res.status(503).json({
            success: false,
            error: 'Database is temporarily unavailable. Please try again later.',
            code: 'DATABASE_UNAVAILABLE',
            timestamp: new Date().toISOString()
          });
          return;
        }

        logger.warn('Onboarding: user not found', { userId });
        res.status(404).json({
          success: false,
          error: 'User account not found. The authenticated user does not exist in the system.',
          code: 'USER_NOT_FOUND',
          timestamp: new Date().toISOString()
        });
        return;
      }

      logger.info('User verified successfully', {
        userId: userId,
        userEmail: userVerification.user.email
      });

      // Validate request body
      const { device_id } = req.body;

      logger.debug('Validating request body', {
        hasDeviceId: !!device_id,
        deviceIdType: typeof device_id,
        deviceIdValue: device_id,
        deviceIdLength: device_id ? device_id.length : 0
      });

      if (!device_id || typeof device_id !== 'string' || device_id.trim().length === 0) {
        logger.warn('Onboarding: invalid or missing device_id', { device_id, type: typeof device_id });
        res.status(400).json({
          success: false,
          error: 'Request body must include a non-empty device_id (string). Example: { "device_id": "my-device-001" }.',
          code: 'DEVICE_ID_REQUIRED',
          timestamp: new Date().toISOString()
        });
        return;
      }

      trimmedDeviceId = device_id.trim();

      logger.debug('Checking for existing certificate', {
        deviceId: trimmedDeviceId
      });

      // Certificate + active-state check: block onboarding when device already has valid cert.
      // Flexibility: in development we allow re-issuing token (set ALLOW_ONBOARDING_WITH_ACTIVE_CERT=true or use NODE_ENV=development).
      const allowReissueWithActiveCert =
        process.env.ALLOW_ONBOARDING_WITH_ACTIVE_CERT === 'true' || process.env.NODE_ENV === 'development';
      const existingCert = await caService.findActiveCertificateByDeviceId(trimmedDeviceId);
      if (existingCert && existingCert.status === 'active') {
        const now = new Date();
        if (existingCert.expires_at > now) {
          // Original strict check: return 409 to frontend (code DEVICE_HAS_ACTIVE_CERTIFICATE). Skipped when allowReissueWithActiveCert.
          if (!allowReissueWithActiveCert) {
            logger.warn('Onboarding: device already has active certificate', {
              device_id: trimmedDeviceId,
              certificateId: existingCert._id,
              expiresAt: existingCert.expires_at
            });
            res.status(409).json({
              success: false,
              error: 'This device already has an active certificate. Revoke the existing certificate first if you need to re-provision.',
              code: 'DEVICE_HAS_ACTIVE_CERTIFICATE',
              certificateId: existingCert._id.toString(),
              timestamp: new Date().toISOString()
            });
            return;
          }
          // Development: allow re-issuing token (ALLOW_ONBOARDING_WITH_ACTIVE_CERT=true or NODE_ENV=development)
          logger.info('Dev mode: re-issuing token despite active certificate', { device_id: trimmedDeviceId });
        }
      }

      logger.debug('Issuing provisioning token', {
        deviceId: trimmedDeviceId,
        userId: userId,
        hasExistingCert: !!existingCert
      });

      // Issue provisioning token with both device_id and user_id bound
      const token = await provisioningService.issueToken(trimmedDeviceId, userId);

      logger.debug('Token issued successfully', {
        deviceId: trimmedDeviceId,
        hasToken: !!token,
        tokenLength: token?.length,
        tokenPreview: token ? token.substring(0, 30) + '...' : null
      });

      logger.info('Provisioning token issued', { 
        device_id: trimmedDeviceId,
        user_id: userId
      });

      // Get token TTL from config
      const tokenTTL = provisioningService.getTokenTTL();

      logger.debug('Onboarding: sending success response', {
        device_id: trimmedDeviceId,
        hasToken: !!token,
        expiresIn: tokenTTL
      });

      // Success: return provisioning token only (no error field)
      res.status(200).json({
        success: true,
        message: 'Provisioning token issued. Use this token in the next step (POST /api/v1/sign-csr) within the validity period. Token is one-time use per sign-csr.',
        provisioning_token: token,
        expires_in: tokenTTL,
        device_id: trimmedDeviceId,
        timestamp: new Date().toISOString()
      });
      return;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const err = error as { statusCode?: number; details?: { token?: string; expiresAt?: unknown; expiresInSeconds?: number } };
      let statusCode = typeof err.statusCode === 'number' ? err.statusCode : 500;

      // Never send 2xx for an error body: if statusCode is success range, treat as 500
      if (statusCode >= 200 && statusCode < 300) {
        statusCode = 500;
      }

      const details = err.details;

      // Handle case where provisioning service threw "token already exists" (409) with details
      if (statusCode === 409 && details?.token) {
        const deviceIdFromBody = (req.body?.device_id && String(req.body.device_id)) || trimmedDeviceId || 'unknown';
        const existingToken = details.token;
        const expiresInSeconds = details.expiresInSeconds;
        const tokenTTL = provisioningService?.getTokenTTL() ?? 300;

        // Critical fix: do NOT return an existing token if it was already consumed (one-time use).
        // This prevents clients from looping on TOKEN_ALREADY_USED at sign-csr.
        let existingValidation: { valid: boolean; error?: string };
        try {
          existingValidation = await provisioningService.peekToken(existingToken);
        } catch (e) {
          logger.warn('Onboarding: token store error while validating existing token; issuing a new token', {
            device_id: deviceIdFromBody,
            error: e instanceof Error ? e.message : e
          });
          existingValidation = { valid: false, error: 'Token store unavailable' };
        }
        if (existingValidation.valid) {
          logger.info('Onboarding: returning existing provisioning token', { device_id: deviceIdFromBody });
          res.status(200).json({
            success: true,
            message:
              'Existing provisioning token is still valid. Use it for POST /api/v1/sign-csr. Token is one-time use per sign-csr.',
            provisioning_token: existingToken,
            expires_in: expiresInSeconds ?? tokenTTL,
            device_id: deviceIdFromBody,
            timestamp: new Date().toISOString()
          });
          return;
        }

        logger.warn('Onboarding: existing token present but not usable; issuing a new token', {
          device_id: deviceIdFromBody,
          error: existingValidation.error
        });

        // Best-effort cleanup then mint a fresh token.
        await provisioningService.revokeToken(existingToken);
        if (!trimmedDeviceId || !userId) {
          logger.error('Onboarding: failed to recover from stale token; missing context for re-issue', {
            hasTrimmedDeviceId: !!trimmedDeviceId,
            hasUserId: !!userId,
            deviceIdFromBody
          });
          res.status(500).json({
            success: false,
            error: 'Failed to recover from stale provisioning token. Please retry onboarding.',
            code: 'INTERNAL_ERROR',
            timestamp: new Date().toISOString()
          });
          return;
        }
        const newToken = await provisioningService.issueToken(trimmedDeviceId, userId);
        res.status(200).json({
          success: true,
          message:
            'A previous provisioning token for this device was already consumed. A new provisioning token was issued. Use it once for POST /api/v1/sign-csr.',
          provisioning_token: newToken,
          expires_in: tokenTTL,
          device_id: trimmedDeviceId,
          timestamp: new Date().toISOString()
        });
        return;
      }

      logger.error('Onboarding: failed to issue token', { error: errorMessage });

      const clientMessage =
        statusCode === 500
          ? 'An unexpected error occurred while issuing the provisioning token. Please try again later.'
          : errorMessage;

      res.status(statusCode).json({
        success: false,
        error: clientMessage,
        ...(statusCode === 500 && { code: 'INTERNAL_ERROR' }),
        timestamp: new Date().toISOString()
      });
    }
  });

  /**
   * POST /api/v1/sign-csr
   * Stage 2: CSR Signing
   * Validates provisioning token and signs CSR to create device certificate
   * 
   * PKI Improvement #6: Rate limiting middleware applied (Redis-backed counters)
   */
  router.post('/sign-csr', csrRateLimiter(), async (req: Request, res: Response): Promise<void> => {
    // Declare variables outside try block for error handling
    let provisioningToken: string | undefined;
    let deviceId: string | undefined;
    
    try {
      logger.debug('CSR signing request received', {
        method: req.method,
        url: req.url,
        hasAuthHeader: !!req.headers.authorization,
        hasBody: !!req.body,
        bodyKeys: req.body ? Object.keys(req.body) : [],
        ip: req.ip
      });

      if (!provisioningService || !caService) {
        logger.error('ProvisioningService or CAService not available');
        res.status(503).json({
          success: false,
          error: 'Provisioning or CA service unavailable',
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Extract provisioning token from Authorization header or body
      const authHeader = req.headers.authorization;

      logger.debug('Extracting provisioning token', {
        hasAuthHeader: !!authHeader,
        authHeaderPrefix: authHeader ? authHeader.substring(0, 20) + '...' : null,
        hasBodyToken: !!req.body?.provisioning_token
      });

      if (authHeader && authHeader.startsWith('Bearer ')) {
        provisioningToken = authHeader.substring(7);
      } else if (req.body.provisioning_token) {
        provisioningToken = req.body.provisioning_token;
      }

      if (!provisioningToken) {
        logger.warn('sign-csr 401: no provisioning token provided', {
          hasAuthHeader: !!authHeader,
          hasBodyToken: !!req.body?.provisioning_token
        });
        res.set('X-Error-Code', 'TOKEN_MISSING');
        res.status(401);
        res.json({
          success: false,
          error: 'provisioning_token is required. Use Authorization: Bearer <token> or body.provisioning_token. This response must be HTTP 401.',
          code: 'TOKEN_MISSING',
          timestamp: new Date().toISOString()
        });
        return;
      }

      logger.debug('Validating provisioning token', {
        tokenLength: provisioningToken.length,
        tokenPreview: provisioningToken.substring(0, 30) + '...'
      });

      // Validate provisioning token
      const tokenValidation = await provisioningService.peekToken(provisioningToken);
      
      logger.debug('Token validation result', {
        valid: tokenValidation.valid,
        deviceId: tokenValidation.deviceId,
        userId: tokenValidation.userId,
        error: tokenValidation.error,
        validationDetails: tokenValidation
      });
      
      if (!tokenValidation.valid || !tokenValidation.deviceId || !tokenValidation.userId) {
        const errMsg = tokenValidation.error || 'Invalid or expired provisioning token';
        const errorCode = getTokenErrorCode(errMsg);
        logger.warn('sign-csr 401: token validation failed', {
          errorCode,
          error: errMsg,
          hasDeviceId: !!tokenValidation.deviceId,
          hasUserId: !!tokenValidation.userId,
          tokenPreview: provisioningToken.substring(0, 30) + '...'
        });
        res.set('X-Error-Code', errorCode);
        res.status(401);
        res.json({
          success: false,
          error: errMsg,
          code: errorCode,
          timestamp: new Date().toISOString()
        });
        return;
      }

      const validatedDeviceId = tokenValidation.deviceId;
      const validatedUserId = tokenValidation.userId; // Extract user_id from token
      deviceId = validatedDeviceId;
      
      logger.debug('Device ID and User ID extracted from token', { deviceId: validatedDeviceId, userId: validatedUserId });

      // Validate request body (only CSR needed now, user_id comes from token)
      // Accept both "csr" and "CSR" for compatibility; ensure we get a string
      const rawCsr = req.body?.csr ?? req.body?.CSR;
      const csr = typeof rawCsr === 'string' ? rawCsr : (rawCsr != null ? String(rawCsr) : undefined);

      logger.debug('Validating request body', {
        hasCSR: !!csr,
        csrLength: csr ? csr.length : 0,
        bodyKeys: req.body ? Object.keys(req.body) : [],
        deviceId: validatedDeviceId,
        userId: validatedUserId
      });

      // Verify user exists in database (using userId from token)
      if (!userService) {
        logger.error('UserService not available');
        res.status(503).json({
          success: false,
          error: 'User verification service unavailable',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const userIdObjectId = new mongoose.Types.ObjectId(validatedUserId);
      const userVerification = await userService.verifyUserExists(userIdObjectId);

      if (!userVerification.found || !userVerification.user) {
        // Check if error is a MongoDB connection issue (should be 503, not 404)
        const isConnectionError = userVerification.error?.includes('MongoDB connection') || 
                                  userVerification.error?.includes('connection');
        
        if (isConnectionError) {
          logger.error('MongoDB connection error during user verification', {
            deviceId,
            userId: validatedUserId,
            error: userVerification.error
          });
          res.status(503).json({
            success: false,
            error: userVerification.error || 'Database service unavailable',
            timestamp: new Date().toISOString()
          });
          return;
        }

        logger.warn('User not found in database', {
          deviceId: validatedDeviceId,
          userId: validatedUserId
        });
        res.status(404).json({
          success: false,
          error: userVerification.error || 'User not found in database',
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Verify device is associated with user (using userId from token)
      const deviceVerification = await userService.verifyDeviceUserAssociation(
        validatedDeviceId,
        userIdObjectId
      );

      if (!deviceVerification.found) {
        // Check if error is a MongoDB connection issue (should be 503, not 404)
        const isConnectionError = deviceVerification.error?.includes('MongoDB connection') || 
                                  deviceVerification.error?.includes('connection');
        
        if (isConnectionError) {
          logger.error('MongoDB connection error during device verification', {
            deviceId: validatedDeviceId,
            userId: validatedUserId,
            error: deviceVerification.error
          });
          res.status(503).json({
            success: false,
            error: deviceVerification.error || 'Database service unavailable',
            timestamp: new Date().toISOString()
          });
          return;
        }

        logger.warn('Device not found in database', {
          deviceId: validatedDeviceId,
          userId: validatedUserId
        });
        res.status(404).json({
          success: false,
          error: deviceVerification.error || 'Device not found in database',
          timestamp: new Date().toISOString()
        });
        return;
      }

      if (!deviceVerification.isAssociated) {
        logger.warn('Device is not associated with the authenticated user', {
          deviceId: validatedDeviceId,
          userId: validatedUserId,
          deviceUserId: deviceVerification.device?.userId?.toString()
        });
        res.status(403).json({
          success: false,
          error: deviceVerification.error || 'Device is not associated with the authenticated user',
          timestamp: new Date().toISOString()
        });
        return;
      }

      logger.info('All validations passed', {
        deviceId: validatedDeviceId,
        userId: validatedUserId,
        userEmail: userVerification.user.email
      });

      // Validate CSR
      if (!csr || typeof csr !== 'string' || csr.trim().length === 0) {
        const bodyKeys = req.body && typeof req.body === 'object' ? Object.keys(req.body) : [];
        logger.warn('sign-csr 400: missing or empty csr', {
          deviceId,
          hasCsr: !!req.body?.csr,
          csrType: typeof req.body?.csr,
          bodyKeys,
          contentType: req.headers['content-type']
        });
        const hint = bodyKeys.length === 0
          ? ' Ensure Content-Type: application/json and request body is valid JSON with a "csr" field.'
          : ` Request body keys received: ${bodyKeys.join(', ')}.`;
        res.status(400).json({
          success: false,
          error: `csr (or CSR) is required in the request body (JSON: { "csr": "<base64 or PEM string>" }) and must be non-empty.${hint}`,
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Decode CSR
      let csrPem: string;
      try {
        const trimmedCsr = csr.trim();

        if (trimmedCsr.includes('-----BEGIN CERTIFICATE REQUEST-----')) {
          csrPem = trimmedCsr.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
        } else {
          csrPem = Buffer.from(trimmedCsr, 'base64').toString('utf8');
        }

        if (!csrPem.includes('-----BEGIN CERTIFICATE REQUEST-----') ||
            !csrPem.includes('-----END CERTIFICATE REQUEST-----')) {
          throw new Error('Decoded value is not a PEM CSR (missing BEGIN/END CERTIFICATE REQUEST)');
        }
      } catch (decodeError) {
        const errorMessage = decodeError instanceof Error ? decodeError.message : 'Unknown error';
        logger.warn('sign-csr 400: invalid CSR format', {
          deviceId,
          error: errorMessage,
          csrLength: csr?.length
        });
        res.status(400).json({
          success: false,
          error: `Invalid CSR format: ${errorMessage}. Send raw PEM or base64-encoded PEM.`,
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Sign CSR and create certificate
      // userIdObjectId already created above for verification, reuse it
      let certificateDoc;
      
      logger.debug('Starting CSR signing', {
        deviceId: validatedDeviceId,
        userId: validatedUserId,
        csrPemLength: csrPem.length
      });

      try {
        certificateDoc = await caService.signCSR(csrPem, validatedDeviceId, validatedUserId);

        // Get Root CA certificate
        const rootCACert = caService.getRootCACertificate();

        logger.info('CSR signed and certificate created', {
          deviceId: validatedDeviceId,
          userId: validatedUserId,
          certificateId: certificateDoc._id
        });

        // One-time use: mark token consumed in store (Redis/memory) until JWT exp
        await provisioningService.finalizeTokenAfterSuccessfulSignCsr(provisioningToken);

        // Get certificate ID
        const certId = certificateDoc._id.toString();
        const expiresAt = typeof certificateDoc.expires_at === 'string'
          ? certificateDoc.expires_at
          : certificateDoc.expires_at.toISOString();

        logger.info('sign-csr 200: certificate issued, provisioning token marked consumed (one-time use)', {
          deviceId: validatedDeviceId,
          certificateId: certId
        });

        // Absolute download URL so clients can use it directly (avoids wrong path when client appends to sign-csr path)
        const pathOnly = `/api/v1/certificates/${certId}/download`;
        const host = req.get('host') || '';
        const protocol = req.protocol || (req.get('x-forwarded-proto') ?? 'http');
        const downloadUrl = host ? `${protocol}://${host}${pathOnly}` : pathOnly;

        // Return certificate and Root CA (provisioning token marked consumed; do not reuse)
        res.set('X-Response-Type', 'certificate-issued');
        res.status(200);
        res.json({
          success: true,
          device_id: validatedDeviceId,
          certificate: certificateDoc.certificate,
          ca_certificate: rootCACert,
          expires_at: expiresAt,
          serial_number: certificateDoc.fingerprint,
          certificateId: certId,
          downloadUrl,
          message: 'Certificate issued. Provisioning token was consumed (one-time use); request a new token from /onboarding for another enrollment.',
          timestamp: new Date().toISOString()
        });
        return;
      } catch (certError) {
        // Device already has active cert (replace not allowed): return 409; token not revoked so client can retry with new token after revoke
        if (certError instanceof DeviceAlreadyHasCertificateError) {
          logger.warn('sign-csr 409: device already has active certificate', { deviceId, certificateId: certError.certificateId });
          res.status(409).json({
            success: false,
            error: certError.message,
            code: 'DEVICE_HAS_ACTIVE_CERTIFICATE',
            certificateId: certError.certificateId,
            timestamp: new Date().toISOString()
          });
          return;
        }

        // Unsupported key type (e.g. ECDSA): return 400; token is never revoked on failure so device can retry
        if (certError instanceof UnsupportedCSRKeyTypeError) {
          logger.warn('sign-csr 400: unsupported CSR key type', {
            deviceId,
            error: certError.message
          });
          res.status(400).json({
            success: false,
            error: certError.message,
            code: 'UNSUPPORTED_CSR_KEY_TYPE',
            timestamp: new Date().toISOString()
          });
          return;
        }

        // CSR validation errors (device ID not in CSR, invalid signature, etc.): return 400 so client sees real reason
        const certErrMsg = certError instanceof Error ? certError.message : 'Unknown error';
        const isCsrValidation =
          certErrMsg.includes('not found in CSR') ||
          certErrMsg.includes('Invalid CSR signature') ||
          certErrMsg.includes('does not contain a public key');
        if (isCsrValidation) {
          const code = certErrMsg.includes('not found in CSR') ? 'INVALID_CSR_DEVICE_ID' : 'INVALID_CSR';
          logger.warn('sign-csr 400: CSR validation failed', { deviceId, error: certErrMsg });
          res.status(400).json({
            success: false,
            error: certErrMsg,
            code,
            timestamp: new Date().toISOString()
          });
          return;
        }

        // Any other CA failure: do NOT revoke token so device can retry
        logger.warn('CSR signing failed, token NOT revoked so device can retry', {
          deviceId,
          error: certErrMsg
        });
        throw certError;
      }
    } catch (error) {
      if (res.headersSent) {
        logger.error('sign-csr: response already sent, cannot send error response', {
          error: error instanceof Error ? error.message : 'Unknown error'
        });
        return;
      }

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStack = error instanceof Error ? error.stack : undefined;

      logger.error('Failed to sign CSR', {
        error: errorMessage,
        stack: errorStack,
        deviceId: deviceId || req.body?.device_id || 'unknown',
        hasCSR: !!req.body?.csr,
        hasToken: !!provisioningToken,
        tokenPreview: provisioningToken ? provisioningToken.substring(0, 30) + '...' : 'none'
      });

      // CSR/validation errors → 400 (so client never sees 500 or wrong message for CSR issues)
      let statusCode = 500;
      let errorResponse: string = 'Internal server error';
      let code: string | undefined;

      let certIdForConflict: string | undefined;

      // If the error is a DeviceAlreadyHasCertificateError that slipped past instanceof
      // (can happen with prototype chain issues in transpiled code), grab certificateId directly.
      const errAny = error as any;
      if (errAny?.certificateId) {
        certIdForConflict = String(errAny.certificateId);
      }

      if (
        errorMessage.includes('E11000') &&
        (errorMessage.includes('device_id') || errorMessage.includes('device_certificates'))
      ) {
        statusCode = 409;
        code = 'DEVICE_HAS_ACTIVE_CERTIFICATE';
        errorResponse = 'Device already has an active certificate';
        if (!certIdForConflict) {
          try {
            const conflictDeviceId = deviceId || req.body?.device_id || '';
            if (conflictDeviceId) {
              // Use findCertificateByDeviceId (no status/expiry filter) so we always find the cert
              const existingCert = await caService.findCertificateByDeviceId(conflictDeviceId);
              if (existingCert) certIdForConflict = existingCert._id.toString();
            }
          } catch (_ignore) {}
        }
      } else if (
        errorMessage.includes('Device already has an active certificate') ||
        errAny?.name === 'DeviceAlreadyHasCertificateError'
      ) {
        statusCode = 409;
        code = 'DEVICE_HAS_ACTIVE_CERTIFICATE';
        errorResponse = errorMessage;
        if (!certIdForConflict) {
          try {
            const conflictDeviceId = deviceId || req.body?.device_id || '';
            if (conflictDeviceId) {
              const existingCert = await caService.findCertificateByDeviceId(conflictDeviceId);
              if (existingCert) certIdForConflict = existingCert._id.toString();
            }
          } catch (_ignore) {}
        }
      } else if (errorMessage.includes('not found in CSR')) {
        statusCode = 400;
        code = 'INVALID_CSR_DEVICE_ID';
        errorResponse = errorMessage;
      } else if (
        errorMessage.includes('Invalid CSR signature') ||
        (errorMessage.includes('CSR') && !errorMessage.includes('Root CA'))
      ) {
        statusCode = 400;
        code = 'INVALID_CSR';
        errorResponse = errorMessage.includes('Certificate signing failed:') ? errorMessage : `Certificate signing failed: ${errorMessage}`;
      } else if (errorMessage.includes('MongoDB') || errorMessage.includes('database')) {
        errorResponse = 'Database error occurred. Please try again.';
        statusCode = 503;
      } else if (errorMessage.includes('Root CA')) {
        errorResponse = 'Certificate Authority error. Please contact support.';
        statusCode = 503;
      }

      res.status(statusCode).json({
        success: false,
        error: errorResponse,
        ...(code && { code }),
        ...(certIdForConflict && { certificateId: certIdForConflict }),
        timestamp: new Date().toISOString()
      });
    }
  });

  /**
   * GET /api/v1/certificates/:certificateId/download
   * Download certificate (works with both storage types)
   */
  router.get('/certificates/:certificateId/download', async (req: Request, res: Response): Promise<void> => {
    try {
      const { certificateId } = req.params;

      if (!certificateId) {
        res.status(400).json({
          success: false,
          error: 'Invalid certificate ID',
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Authenticate: prefer auth_token (AUTH_SECRET) via Authorization header.
      // For backward-compatibility, fall back to provisioning token (including consumed) via Authorization or ?token=.
      const authHeader = req.headers.authorization;
      const bearer = (authHeader && authHeader.startsWith('Bearer ')) ? authHeader.substring(7) : undefined;
      const queryToken = req.query.token as string | undefined;
      const tokenCandidate = bearer ?? queryToken;

      if (!tokenCandidate) {
        res.status(401).json({
          success: false,
          error: 'Authorization required. Send auth token as Authorization: Bearer <auth_token>. (Legacy: provisioning token also accepted via Authorization or ?token=.)',
          code: 'AUTH_TOKEN_MISSING',
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Find certificate using dual-storage method
      const certificateDoc = await caService.findCertificateById(certificateId);

      if (!certificateDoc) {
        res.status(404).json({
          success: false,
          error: 'Certificate not found',
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Try auth token first (recommended path)
      const authVerification = await authService.verifyAuthToken(tokenCandidate);
      if (authVerification.valid && authVerification.userId) {
        if (String(certificateDoc.user_id) !== String(authVerification.userId)) {
          res.status(403).json({
            success: false,
            error: 'Certificate does not belong to the authenticated user',
            timestamp: new Date().toISOString()
          });
          return;
        }
      } else {
        // Legacy path: treat as provisioning token for download (allows consumed tokens)
        const tokenValidation = await provisioningService.peekTokenForDownload(tokenCandidate);
        if (!tokenValidation.valid) {
          const errMsg = authVerification.error || tokenValidation.error || 'Invalid or expired token';
          const errorCode = authVerification.error ? 'AUTH_TOKEN_INVALID' : getTokenErrorCode(errMsg);
          res.set('X-Error-Code', errorCode);
          res.status(401).json({
            success: false,
            error: errMsg,
            code: errorCode,
            timestamp: new Date().toISOString()
          });
          return;
        }

        // IMPORTANT: bind the token to the certificate being downloaded.
        // Prevents a provisioning token (even consumed) from device-A being used to download device-B's cert.
        if (tokenValidation.deviceId && certificateDoc.device_id !== tokenValidation.deviceId) {
          res.status(403).json({
            success: false,
            error: 'Certificate does not belong to this device',
            code: 'CERT_DEVICE_MISMATCH',
            timestamp: new Date().toISOString()
          });
          return;
        }

        // Additional binding: token user must match cert user (defense in depth).
        if (tokenValidation.userId && String(certificateDoc.user_id) !== String(tokenValidation.userId)) {
          res.status(403).json({
            success: false,
            error: 'Certificate does not belong to the token user',
            code: 'CERT_USER_MISMATCH',
            timestamp: new Date().toISOString()
          });
          return;
        }
      }

      const rootCACert = caService.getRootCACertificate();
      const expiresAt = typeof certificateDoc.expires_at === 'string'
        ? certificateDoc.expires_at
        : certificateDoc.expires_at.toISOString();

      // Return flat PEM strings (same shape as the sign-csr 200 response)
      // so clients can parse both endpoints identically.
      res.status(200).json({
        success: true,
        device_id: certificateDoc.device_id,
        certificate: certificateDoc.certificate,
        ca_certificate: rootCACert,
        expires_at: expiresAt,
        serial_number: certificateDoc.fingerprint,
        certificateId,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to download certificate', { error: errorMessage });

      res.status(500).json({
        success: false,
        error: 'Internal server error',
        timestamp: new Date().toISOString()
      });
    }
  });

  /**
   * POST /api/v1/certificates/recover
   * Recover an already-issued certificate for a device.
   *
   * Intended for real-world cases like:
   * - device completed sign-csr but failed to persist the response
   * - server restarted mid-flow and in-memory provisioning tokens were lost
   *
   * Auth:
   *   Authorization: Bearer <auth_token> (AUTH_SECRET)
   *
   * Body:
   *   { "device_id": "device-123" }
   */
  router.post('/certificates/recover', async (req: Request, res: Response): Promise<void> => {
    try {
      if (!authService || !userService || !caService) {
        res.status(503).json({
          success: false,
          error: 'Service unavailable',
          code: 'SERVICE_UNAVAILABLE',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const authHeader = req.headers.authorization;
      const authToken = (authHeader && authHeader.startsWith('Bearer ')) ? authHeader.substring(7) : undefined;
      if (!authToken || typeof authToken !== 'string' || authToken.trim().length === 0) {
        res.status(401).json({
          success: false,
          error: 'Authentication required. Send a valid auth token in the Authorization header as: Bearer <auth_token>.',
          code: 'AUTH_TOKEN_MISSING',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const authVerification = await authService.verifyAuthToken(authToken);
      if (!authVerification.valid || !authVerification.userId) {
        res.status(401).json({
          success: false,
          error: authVerification.error || 'The auth token is invalid or expired. Sign in again to get a new token.',
          code: 'AUTH_TOKEN_INVALID',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const rawDeviceId = req.body?.device_id;
      if (typeof rawDeviceId !== 'string' || rawDeviceId.trim().length === 0) {
        res.status(400).json({
          success: false,
          error: 'Request body must include a non-empty device_id (string). Example: { "device_id": "my-device-001" }.',
          code: 'DEVICE_ID_REQUIRED',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const deviceId = rawDeviceId.trim();
      const userId = authVerification.userId;
      const userIdObjectId = new mongoose.Types.ObjectId(userId);

      const userVerification = await userService.verifyUserExists(userIdObjectId);
      if (!userVerification.found || !userVerification.user) {
        const isConnectionError =
          userVerification.error?.includes('MongoDB connection') || userVerification.error?.includes('connection');
        if (isConnectionError) {
          res.status(503).json({
            success: false,
            error: 'Database is temporarily unavailable. Please try again later.',
            code: 'DATABASE_UNAVAILABLE',
            timestamp: new Date().toISOString()
          });
          return;
        }
        res.status(404).json({
          success: false,
          error: 'User account not found. The authenticated user does not exist in the system.',
          code: 'USER_NOT_FOUND',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const deviceVerification = await userService.verifyDeviceUserAssociation(deviceId, userIdObjectId);
      if (!deviceVerification.found) {
        const isConnectionError =
          deviceVerification.error?.includes('MongoDB connection') || deviceVerification.error?.includes('connection');
        if (isConnectionError) {
          res.status(503).json({
            success: false,
            error: deviceVerification.error || 'Database service unavailable',
            code: 'DATABASE_UNAVAILABLE',
            timestamp: new Date().toISOString()
          });
          return;
        }
        res.status(404).json({
          success: false,
          error: deviceVerification.error || 'Device not found in database',
          code: 'DEVICE_NOT_FOUND',
          timestamp: new Date().toISOString()
        });
        return;
      }

      if (!deviceVerification.isAssociated) {
        res.status(403).json({
          success: false,
          error: deviceVerification.error || 'Device is not associated with the authenticated user',
          code: 'FORBIDDEN',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const certificateDoc = await caService.findCertificateByDeviceId(deviceId);
      if (!certificateDoc) {
        res.status(404).json({
          success: false,
          error: 'No certificate found for this device',
          code: 'CERTIFICATE_NOT_FOUND',
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Ownership check (defense in depth; device association should already enforce this).
      if (String(certificateDoc.user_id) !== String(userId)) {
        res.status(403).json({
          success: false,
          error: 'Certificate does not belong to the authenticated user',
          code: 'FORBIDDEN',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const rootCACert = caService.getRootCACertificate();
      const expiresAt = typeof certificateDoc.expires_at === 'string'
        ? certificateDoc.expires_at
        : certificateDoc.expires_at.toISOString();
      const certId = certificateDoc._id.toString();

      res.status(200).json({
        success: true,
        device_id: certificateDoc.device_id,
        certificate: certificateDoc.certificate,
        ca_certificate: rootCACert,
        expires_at: expiresAt,
        serial_number: certificateDoc.fingerprint,
        certificateId: certId,
        status: certificateDoc.status,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to recover certificate', { error: errorMessage });
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        code: 'INTERNAL_ERROR',
        timestamp: new Date().toISOString()
      });
    }
  });

  /**
   * GET /api/v1/certificates/:deviceId/status
   * Get certificate status for a device (works with both storage types)
   */
  router.get('/certificates/:deviceId/status', async (req: Request, res: Response): Promise<void> => {
    try {
      const { deviceId } = req.params;
      const certificateDoc = await caService.findCertificateByDeviceId(deviceId);

      if (!certificateDoc) {
        res.status(404).json({
          success: false,
          error: 'No certificate found for this device',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const expiresAt = typeof certificateDoc.expires_at === 'string'
        ? certificateDoc.expires_at
        : certificateDoc.expires_at.toISOString();
      const createdAt = typeof certificateDoc.created_at === 'string'
        ? certificateDoc.created_at
        : certificateDoc.created_at?.toISOString();

      res.status(200).json({
        success: true,
        device_id: certificateDoc.device_id,
        status: certificateDoc.status,
        expires_at: expiresAt,
        created_at: createdAt,
        fingerprint: certificateDoc.fingerprint,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to get certificate status', { error: errorMessage });

      res.status(500).json({
        success: false,
        error: 'Internal server error',
        timestamp: new Date().toISOString()
      });
    }
  });

  /**
   * DELETE /api/v1/certificates/:deviceId
   * Revoke certificate for a device (works with both storage types)
   */
  router.delete('/certificates/:deviceId', async (req: Request, res: Response): Promise<void> => {
    try {
      const { deviceId } = req.params;
      const certificateDoc = await caService.findCertificateByDeviceId(deviceId);

      if (!certificateDoc) {
        res.status(404).json({
          success: false,
          error: 'No certificate found for this device',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const certId = (certificateDoc as any)._id?.toString() || (certificateDoc as any).id;
      await caService.updateCertificateStatus(certId, DeviceCertificateStatus.revoked);

      logger.info('Certificate revoked', { deviceId, certificateId: certId });

      res.status(200).json({
        success: true,
        message: 'Certificate revoked successfully',
        device_id: deviceId,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to revoke certificate', { error: errorMessage });

      res.status(500).json({
        success: false,
        error: 'Internal server error',
        timestamp: new Date().toISOString()
      });
    }
  });

  return router;
}

