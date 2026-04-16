import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import { logger } from '../utils/logger';
import { CAService } from '../services/caService';
import { AuthService } from '../services/authService';
import { UserService } from '../services/userService';
import { requireMtlsDeviceCert } from '../middleware/mtlsAuth';
import { DeviceCertificate, DeviceCertificateStatus } from '../models/DeviceCertificate';

function decodeCsrToPem(raw: unknown): string {
  const csr = typeof raw === 'string' ? raw.trim() : (raw != null ? String(raw).trim() : '');
  if (!csr) throw new Error('csr is required');

  if (csr.includes('-----BEGIN CERTIFICATE REQUEST-----')) {
    const pem = csr.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
    if (!pem.includes('-----END CERTIFICATE REQUEST-----')) {
      throw new Error('csr PEM missing END CERTIFICATE REQUEST');
    }
    return pem;
  }

  const pem = Buffer.from(csr, 'base64').toString('utf8');
  if (!pem.includes('-----BEGIN CERTIFICATE REQUEST-----') || !pem.includes('-----END CERTIFICATE REQUEST-----')) {
    throw new Error('csr must be PEM or base64-encoded PEM CSR');
  }
  return pem;
}

export interface LifecycleDeps {
  caService: CAService;
  authService: AuthService;
  userService: UserService;
}

export function createLifecycleRoutes(deps: LifecycleDeps): Router {
  const router = Router();
  const { caService, authService, userService } = deps;

  /**
   * Flow 2.2: POST /api/v1/certificates/renewAuth
   * Auth: mTLS (primary cert) via proxy header middleware.
   * Body: { csr: "<pem-or-base64-pem>" }
   * Response: { certificate, ca_certificate, expires_at, fingerprint, slot }
   */
  router.post(
    '/certificates/renewAuth',
    requireMtlsDeviceCert({ allowedSlots: ['primary'] }),
    async (req: Request, res: Response) => {
      try {
        const deviceId = req.deviceId;
        if (!deviceId) {
          res.status(401).json({ success: false, error: 'mTLS required', code: 'MTLS_REQUIRED' });
          return;
        }

        const csrPem = decodeCsrToPem((req.body as any)?.csr ?? (req.body as any)?.CSR);

        // Bind renewal to the same userId as the current primary certificate.
        const primary = await DeviceCertificate.findOne({
          device_id: deviceId,
          slot: 'primary',
          status: DeviceCertificateStatus.active
        });
        if (!primary) {
          res.status(403).json({
            success: false,
            error: 'No active primary certificate found for device',
            code: 'PRIMARY_CERT_NOT_FOUND',
            device_id: deviceId
          });
          return;
        }

        const certDoc = await caService.signCSR(csrPem, deviceId, String(primary.user_id), { slot: 'staging' });
        res.status(200).json({
          success: true,
          device_id: deviceId,
          slot: (certDoc as any).slot || 'staging',
          certificate: (certDoc as any).certificate,
          ca_certificate: caService.getRootCACertificate(),
          expires_at:
            typeof (certDoc as any).expires_at === 'string'
              ? (certDoc as any).expires_at
              : (certDoc as any).expires_at?.toISOString?.() ?? null,
          fingerprint: (certDoc as any).fingerprint,
          timestamp: new Date().toISOString()
        });
      } catch (err: any) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn('renewAuth failed', { error: msg });
        res.status(400).json({ success: false, error: msg, code: 'RENEW_AUTH_FAILED', timestamp: new Date().toISOString() });
      }
    }
  );

  /**
   * Flow 2.4: POST /api/v1/certificates/confirm
   * Auth: mTLS (staging cert) via proxy header middleware.
   * Effect: promote staging→primary, revoke old primary.
   */
  router.post(
    '/certificates/confirm',
    requireMtlsDeviceCert({ allowedSlots: ['staging'] }),
    async (req: Request, res: Response) => {
      try {
        const deviceId = req.deviceId;
        if (!deviceId) {
          res.status(401).json({ success: false, error: 'mTLS required', code: 'MTLS_REQUIRED' });
          return;
        }

        const result = await caService.promoteStagingToPrimary(deviceId);
        if (!result.promoted) {
          res.status(409).json({
            success: false,
            error: 'No active staging certificate found to promote',
            code: 'NO_STAGING_CERT',
            device_id: deviceId,
            timestamp: new Date().toISOString()
          });
          return;
        }

        res.status(200).json({
          success: true,
          device_id: deviceId,
          status: 'promoted',
          timestamp: new Date().toISOString()
        });
      } catch (err: any) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('confirm failed', { error: msg });
        res.status(500).json({ success: false, error: 'Internal server error', code: 'CONFIRM_FAILED', timestamp: new Date().toISOString() });
      }
    }
  );

  /**
   * Flow 4: POST /api/v1/certificates/reissue
   * Auth: Authorization: Bearer <user_auth_token>
   * Body: { device_id: string, csr: "<pem-or-base64-pem>" }
   */
  router.post('/certificates/reissue', async (req: Request, res: Response) => {
    try {
      const authHeader = req.headers.authorization;
      const authToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.substring(7) : undefined;
      if (!authToken) {
        res.status(401).json({ success: false, error: 'Authentication required', code: 'AUTH_TOKEN_MISSING', timestamp: new Date().toISOString() });
        return;
      }

      const authVerification = await authService.verifyAuthToken(authToken);
      if (!authVerification.valid || !authVerification.userId) {
        res.status(401).json({ success: false, error: authVerification.error || 'Invalid auth token', code: 'AUTH_TOKEN_INVALID', timestamp: new Date().toISOString() });
        return;
      }

      const rawDeviceId = (req.body as any)?.device_id;
      if (typeof rawDeviceId !== 'string' || rawDeviceId.trim().length === 0) {
        res.status(400).json({ success: false, error: 'device_id is required', code: 'DEVICE_ID_REQUIRED', timestamp: new Date().toISOString() });
        return;
      }

      const deviceId = rawDeviceId.trim();
      const userId = authVerification.userId;
      const userIdObjectId = new mongoose.Types.ObjectId(userId);

      const userCheck = await userService.verifyUserExists(userIdObjectId);
      if (!userCheck.found || !userCheck.user) {
        res.status(404).json({ success: false, error: userCheck.error || 'User not found', code: 'USER_NOT_FOUND', timestamp: new Date().toISOString() });
        return;
      }

      const assoc = await userService.verifyDeviceUserAssociation(deviceId, userIdObjectId);
      if (!assoc.found) {
        res.status(404).json({ success: false, error: assoc.error || 'Device not found', code: 'DEVICE_NOT_FOUND', timestamp: new Date().toISOString() });
        return;
      }
      if (!assoc.isAssociated) {
        res.status(403).json({ success: false, error: assoc.error || 'Device not associated with user', code: 'FORBIDDEN', timestamp: new Date().toISOString() });
        return;
      }

      const csrPem = decodeCsrToPem((req.body as any)?.csr ?? (req.body as any)?.CSR);

      await caService.revokeAllDeviceCertificates(deviceId);
      const certDoc = await caService.signCSR(csrPem, deviceId, userId, { slot: 'primary', allowReplacePrimary: true });

      res.status(200).json({
        success: true,
        device_id: deviceId,
        slot: (certDoc as any).slot || 'primary',
        certificate: (certDoc as any).certificate,
        ca_certificate: caService.getRootCACertificate(),
        expires_at:
          typeof (certDoc as any).expires_at === 'string'
            ? (certDoc as any).expires_at
            : (certDoc as any).expires_at?.toISOString?.() ?? null,
        fingerprint: (certDoc as any).fingerprint,
        timestamp: new Date().toISOString()
      });
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('reissue failed', { error: msg });
      res.status(500).json({ success: false, error: 'Internal server error', code: 'REISSUE_FAILED', timestamp: new Date().toISOString() });
    }
  });

  return router;
}

