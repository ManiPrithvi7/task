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
import { DeviceCertificateStatus } from '../models/DeviceCertificate';

export interface ProvisioningDependencies {
  provisioningService: ProvisioningService;
  caService: CAService;
}

export function createProvisioningRoutes(dependencies: ProvisioningDependencies): Router {
  const router = Router();
  const { provisioningService, caService } = dependencies;

  /**
   * POST /api/v1/onboarding
   * Stage 1: Token Issuance
   */
  router.post('/onboarding', async (req: Request, res: Response): Promise<void> => {
    try {
      logger.debug('Onboarding request received', {
        method: req.method,
        url: req.url,
        hasBody: !!req.body,
        ip: req.ip
      });

      const { device_id } = req.body;

      if (!device_id || typeof device_id !== 'string' || device_id.trim().length === 0) {
        res.status(400).json({
          success: false,
          error: 'device_id is required and must be a non-empty string',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const trimmedDeviceId = device_id.trim();

      // Check if device already has a certificate (works with both storage types)
      const existingCert = await caService.findActiveCertificateByDeviceId(trimmedDeviceId);
      
      if (existingCert) {
        const certId = (existingCert as any)._id || (existingCert as any).id;
        logger.warn('Device already has active certificate', {
          device_id: trimmedDeviceId,
          certificateId: certId
        });
        res.status(409).json({
          success: false,
          error: 'Device already has an active certificate',
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Issue provisioning token
      const token = await provisioningService.issueToken(trimmedDeviceId);
      const tokenTTL = provisioningService.getTokenTTL();

      logger.info('Provisioning token issued', { device_id: trimmedDeviceId });

      res.status(200).json({
        success: true,
        provisioning_token: token,
        expires_in: tokenTTL,
        timestamp: new Date().toISOString()
      });
    } catch (error: any) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const statusCode = error.statusCode || 500;
      const details = error.details;

      if (statusCode === 409) {
        res.status(409).json({
          success: false,
          error: details?.message || errorMessage,
          expiresAt: details?.expiresAt,
          expiresInSeconds: details?.expiresInSeconds,
          existingToken: details?.token,
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
   */
  router.post('/sign-csr', async (req: Request, res: Response): Promise<void> => {
    try {
      logger.debug('CSR signing request received', {
        method: req.method,
        url: req.url,
        hasAuthHeader: !!req.headers.authorization,
        ip: req.ip
      });

      // Extract provisioning token
      const authHeader = req.headers.authorization;
      let provisioningToken: string | undefined;

      if (authHeader && authHeader.startsWith('Bearer ')) {
        provisioningToken = authHeader.substring(7);
      } else if (req.body.provisioning_token) {
        provisioningToken = req.body.provisioning_token;
      }

      if (!provisioningToken) {
        res.status(401).json({
          success: false,
          error: 'provisioning_token is required in Authorization header (Bearer token) or request body',
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Validate provisioning token
      const tokenValidation = await provisioningService.validateToken(provisioningToken);

      if (!tokenValidation.valid || !tokenValidation.deviceId) {
        res.status(401).json({
          success: false,
          error: tokenValidation.error || 'Invalid or expired provisioning token',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const deviceId = tokenValidation.deviceId;

      // Validate request body
      const { csr, user_id } = req.body;

      if (!csr || typeof csr !== 'string' || csr.trim().length === 0) {
        res.status(400).json({
          success: false,
          error: 'csr is required and must be a Base64-encoded PEM string',
          timestamp: new Date().toISOString()
        });
        return;
      }

      if (!user_id || typeof user_id !== 'string' || user_id.trim().length === 0) {
        res.status(400).json({
          success: false,
          error: 'user_id is required',
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

      try {
        // Sign CSR
        const certificateDoc = await caService.signCSR(csrPem, deviceId, user_id);
        const rootCACert = caService.getRootCACertificate();

        // Revoke provisioning token
        await provisioningService.revokeToken(provisioningToken);

        // Get certificate ID (works with both storage types)
        const certId = (certificateDoc as any)._id?.toString() || (certificateDoc as any).id;
        const expiresAt = typeof certificateDoc.expires_at === 'string' 
          ? certificateDoc.expires_at 
          : certificateDoc.expires_at.toISOString();

        logger.info('CSR signed and certificate created', {
          deviceId,
          userId: user_id,
          certificateId: certId
        });

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
        // Revoke token on failure
        await provisioningService.revokeToken(provisioningToken);
        throw certError;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to sign CSR', { error: errorMessage });

      res.status(500).json({
        success: false,
        error: 'Internal server error',
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

