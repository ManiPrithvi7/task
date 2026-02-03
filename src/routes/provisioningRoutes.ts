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
  return 'TOKEN_INVALID';
}

export function createProvisioningRoutes(dependencies: ProvisioningDependencies): Router {
  const router = Router();
  const { provisioningService, caService, authService, userService } = dependencies;

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

      const userId = authTokenVerification.userId;

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

      const trimmedDeviceId = device_id.trim();

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
        const deviceId = req.body?.device_id || 'unknown';
        const existingToken = details.token;
        const expiresInSeconds = details.expiresInSeconds;
        const tokenTTL = provisioningService?.getTokenTTL() ?? 300;

        logger.info('Onboarding: returning existing provisioning token', { device_id: deviceId });

        res.status(200).json({
          success: true,
          message: 'Existing provisioning token is still valid. Use it for POST /api/v1/sign-csr. Token is one-time use per sign-csr.',
          provisioning_token: existingToken,
          expires_in: expiresInSeconds ?? tokenTTL,
          device_id: deviceId,
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
   */
  router.post('/sign-csr', async (req: Request, res: Response): Promise<void> => {
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
      const tokenValidation = await provisioningService.validateToken(provisioningToken);
      
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

      deviceId = tokenValidation.deviceId;
      const userId = tokenValidation.userId;  // Extract user_id from token
      
      logger.debug('Device ID and User ID extracted from token', { deviceId, userId });

      // Validate request body (only CSR needed now, user_id comes from token)
      // Accept both "csr" and "CSR" for compatibility; ensure we get a string
      const rawCsr = req.body?.csr ?? req.body?.CSR;
      const csr = typeof rawCsr === 'string' ? rawCsr : (rawCsr != null ? String(rawCsr) : undefined);

      logger.debug('Validating request body', {
        hasCSR: !!csr,
        csrLength: csr ? csr.length : 0,
        bodyKeys: req.body ? Object.keys(req.body) : [],
        deviceId,
        userId
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

      const userIdObjectId = new mongoose.Types.ObjectId(userId);
      const userVerification = await userService.verifyUserExists(userIdObjectId);

      if (!userVerification.found || !userVerification.user) {
        // Check if error is a MongoDB connection issue (should be 503, not 404)
        const isConnectionError = userVerification.error?.includes('MongoDB connection') || 
                                  userVerification.error?.includes('connection');
        
        if (isConnectionError) {
          logger.error('MongoDB connection error during user verification', {
            deviceId,
            userId: userId,
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
          deviceId,
          userId: userId
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
        deviceId,
        userIdObjectId
      );

      if (!deviceVerification.found) {
        // Check if error is a MongoDB connection issue (should be 503, not 404)
        const isConnectionError = deviceVerification.error?.includes('MongoDB connection') || 
                                  deviceVerification.error?.includes('connection');
        
        if (isConnectionError) {
          logger.error('MongoDB connection error during device verification', {
            deviceId,
            userId: userId,
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
          deviceId,
          userId: userId
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
          deviceId,
          userId: userId,
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
        deviceId,
        userId: userId,
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
          error: `csr is required in the request body (JSON: { "csr": "<base64 or PEM string>" }) and must be non-empty.${hint}`,
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
        deviceId,
        userId: userId,
        csrPemLength: csrPem.length
      });

      try {
        certificateDoc = await caService.signCSR(csrPem, deviceId, userId);

        // Get Root CA certificate
        const rootCACert = caService.getRootCACertificate();

        logger.info('CSR signed and certificate created', {
          deviceId,
          userId: userId,
          certificateId: certificateDoc._id
        });

        // Revoke provisioning token after successful certificate creation (one-time use)
        await provisioningService.revokeToken(provisioningToken);

        // Get certificate ID
        const certId = certificateDoc._id.toString();
        const expiresAt = typeof certificateDoc.expires_at === 'string'
          ? certificateDoc.expires_at
          : certificateDoc.expires_at.toISOString();

        logger.info('sign-csr 200: certificate issued, token revoked (one-time use)', {
          deviceId,
          certificateId: certId
        });

        // Return certificate and Root CA (provisioning token was revoked; do not reuse)
        res.set('X-Response-Type', 'certificate-issued');
        res.status(200);
        res.json({
          success: true,
          device_id: deviceId,
          certificate: certificateDoc.certificate,
          ca_certificate: rootCACert,
          expires_at: expiresAt,
          serial_number: certificateDoc.fingerprint,
          certificateId: certId,
          downloadUrl: `/api/v1/certificates/${certId}/download`,
          message: 'Certificate issued. Provisioning token has been revoked; request a new token from /onboarding for another device.',
          timestamp: new Date().toISOString()
        });
        return;
      } catch (certError) {
        // Device already has active cert (replace not allowed): return 409; token not revoked so client can retry with new token after revoke
        if (certError instanceof DeviceAlreadyHasCertificateError) {
          logger.warn('sign-csr 409: device already has active certificate', { deviceId });
          res.status(409).json({
            success: false,
            error: certError.message,
            code: 'DEVICE_HAS_ACTIVE_CERTIFICATE',
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

      if (
        errorMessage.includes('E11000') &&
        (errorMessage.includes('device_id') || errorMessage.includes('device_certificates'))
      ) {
        statusCode = 409;
        code = 'DEVICE_HAS_ACTIVE_CERTIFICATE';
        errorResponse = 'Device already has an active certificate';
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

      const rootCACert = caService.getRootCACertificate();
      const expiresAt = typeof certificateDoc.expires_at === 'string'
        ? certificateDoc.expires_at
        : certificateDoc.expires_at.toISOString();

      const response: any = {
        success: true,
        device_id: certificateDoc.device_id,
        certificate: {
          content: certificateDoc.certificate,
          filename: `device-${certificateDoc.device_id}.crt`,
          expires_at: expiresAt
        },
        ca_certificate: {
          content: rootCACert,
          filename: 'root-ca.crt'
        },
        timestamp: new Date().toISOString()
      };

      if (certificateDoc.private_key) {
        response.private_key = {
          content: certificateDoc.private_key,
          filename: `device-${certificateDoc.device_id}.key`,
          warning: 'Keep this private key secure'
        };
      } else {
        response.private_key = {
          content: null,
          filename: `device-${certificateDoc.device_id}.key`,
          note: 'Private key is stored on the device (CSR signing)'
        };
      }

      res.status(200).json(response);
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

