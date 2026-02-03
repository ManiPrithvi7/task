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
import { CAService } from '../services/caService';
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
        logger.error('ProvisioningService not available');
        res.status(503).json({
          success: false,
          error: 'Provisioning service unavailable',
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
        logger.warn('No auth_token provided in Authorization header', {
          hasAuthHeader: !!authHeader
        });
        res.status(401).json({
          success: false,
          error: 'auth_token is required in Authorization header (Bearer token)',
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Verify auth_token using AuthService
      if (!authService) {
        logger.error('AuthService not available');
        res.status(503).json({
          success: false,
          error: 'Authentication service unavailable',
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
        logger.warn('Auth token validation failed', {
          error: authTokenVerification.error,
          authTokenPreview: authToken.substring(0, 30) + '...'
        });
        res.status(401).json({
          success: false,
          error: authTokenVerification.error || 'Invalid or expired auth_token',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const userId = authTokenVerification.userId;

      // Verify user exists in database
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
          userId: userId
        });
        res.status(404).json({
          success: false,
          error: userVerification.error || 'User not found in database',
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
        logger.warn('Invalid device_id in request', {
          device_id,
          type: typeof device_id
        });
        res.status(400).json({
          success: false,
          error: 'device_id is required and must be a non-empty string',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const trimmedDeviceId = device_id.trim();

      logger.debug('Checking for existing certificate', {
        deviceId: trimmedDeviceId
      });

      // Check if device already has a certificate
      const existingCert = await caService.findActiveCertificateByDeviceId(trimmedDeviceId);
      if (existingCert && existingCert.status === 'active') {
        const now = new Date();
        if (existingCert.expires_at > now) {
          logger.warn('Device already has active certificate', { 
            device_id: trimmedDeviceId,
            certificateId: existingCert._id,
            expiresAt: existingCert.expires_at
          });
          res.status(409).json({
            success: false,
            error: 'Device already has an active certificate',
            timestamp: new Date().toISOString()
          });
          return;
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

      // Prepare response
      const response = {
        success: true,
        provisioning_token: token,
        expires_in: tokenTTL,
        timestamp: new Date().toISOString()
      };

      logger.debug('Sending provisioning token response', { 
        device_id: trimmedDeviceId,
        hasToken: !!token,
        tokenLength: token?.length,
        expiresIn: tokenTTL
      });

      // Send response
      res.status(200).json(response);
      
      return;
    } catch (error: any) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const statusCode = error.statusCode || 500;
      const details = error.details;
      
      // Handle case where token already exists - return success with existing token
      if (statusCode === 409) {
        const deviceId = req.body?.device_id || 'unknown';
        const existingToken = details?.token;
        const expiresAt = details?.expiresAt;
        const expiresInSeconds = details?.expiresInSeconds;
        
        logger.info('Returning existing provisioning token', { 
          device_id: deviceId,
          expiresAt,
          expiresInSeconds
        });
        
        // Get token TTL from config
        const tokenTTL = provisioningService.getTokenTTL();
        
        // Return success with existing token
        res.status(200).json({
          success: true,
          provisioning_token: existingToken,
          expires_in: expiresInSeconds || tokenTTL,
          message: 'Using existing active provisioning token',
          timestamp: new Date().toISOString()
        });
        return;
      }
      
      logger.error('Failed to issue provisioning token', { error: errorMessage });
      
      res.status(statusCode).json({
        success: false,
        error: statusCode === 500 ? 'Internal server error' : errorMessage,
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
        logger.warn('No provisioning token provided', {
          hasAuthHeader: !!authHeader,
          hasBodyToken: !!req.body?.provisioning_token
        });
        res.status(401).json({
          success: false,
          error: 'provisioning_token is required in Authorization header (Bearer token) or request body',
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
        logger.warn('Token validation failed', {
          error: tokenValidation.error,
          hasDeviceId: !!tokenValidation.deviceId,
          hasUserId: !!tokenValidation.userId,
          tokenPreview: provisioningToken.substring(0, 30) + '...'
        });
        res.status(401).json({
          success: false,
          error: tokenValidation.error || 'Invalid or expired provisioning token',
          timestamp: new Date().toISOString()
        });
        return;
      }

      deviceId = tokenValidation.deviceId;
      const userId = tokenValidation.userId;  // Extract user_id from token
      
      logger.debug('Device ID and User ID extracted from token', { deviceId, userId });

      // Validate request body (only CSR needed now, user_id comes from token)
      const { csr } = req.body;

      logger.debug('Validating request body', {
        hasCSR: !!csr,
        csrLength: csr ? csr.length : 0,
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
        res.status(400).json({
          success: false,
          error: 'csr is required and must be a Base64-encoded PEM string',
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
          throw new Error('Invalid CSR format');
        }
      } catch (decodeError) {
        const errorMessage = decodeError instanceof Error ? decodeError.message : 'Unknown error';
        res.status(400).json({
          success: false,
          error: `Invalid CSR format: ${errorMessage}`,
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

        // Revoke provisioning token after successful certificate creation
        await provisioningService.revokeToken(provisioningToken);

        // Get certificate ID
        const certId = certificateDoc._id.toString();
        const expiresAt = typeof certificateDoc.expires_at === 'string' 
          ? certificateDoc.expires_at 
          : certificateDoc.expires_at.toISOString();

        // Return certificate and Root CA
        res.status(200).json({
          success: true,
          device_id: deviceId,
          certificate: certificateDoc.certificate,
          ca_certificate: rootCACert,
          expires_at: expiresAt,
          serial_number: certificateDoc.fingerprint,
          certificateId: certId,
          downloadUrl: `/api/v1/certificates/${certId}/download`,
          timestamp: new Date().toISOString()
        });
      } catch (certError) {
        // Provisioning failed - revoke token to allow retry
        logger.error('CSR signing failed, revoking provisioning token', {
          deviceId,
          error: certError instanceof Error ? certError.message : 'Unknown error'
        });
        
        try {
          await provisioningService.revokeToken(provisioningToken);
          logger.info('Provisioning token revoked due to failure', { deviceId });
        } catch (revokeError) {
          logger.error('Failed to revoke token after provisioning failure', {
            deviceId,
            error: revokeError instanceof Error ? revokeError.message : 'Unknown error'
          });
        }
        
        // Re-throw to be handled by outer catch
        throw certError;
      }
    } catch (error) {
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

      // Provide more specific error messages for common issues
      let statusCode = 500;
      let errorResponse = 'Internal server error';
      
      if (errorMessage.includes('CSR') || errorMessage.includes('certificate')) {
        errorResponse = `Certificate signing failed: ${errorMessage}`;
      } else if (errorMessage.includes('MongoDB') || errorMessage.includes('database')) {
        errorResponse = 'Database error occurred. Please try again.';
        statusCode = 503;
      } else if (errorMessage.includes('Root CA')) {
        errorResponse = 'Certificate Authority error. Please contact support.';
        statusCode = 503;
      } else {
        // For unknown errors, log full details but return generic message
        errorResponse = 'Internal server error';
      }

      res.status(statusCode).json({
        success: false,
        error: errorResponse,
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

