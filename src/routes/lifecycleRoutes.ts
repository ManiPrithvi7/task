import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { logger } from '../utils/logger';
import { CAService, DeviceAlreadyHasCertificateError, UnsupportedCSRKeyTypeError } from '../services/caService';
import { RecoveryCodeService } from '../services/recoveryCodeService';
import { requireMtlsDeviceCert } from '../middleware/mtlsAuth';
import { DeviceCertificate, DeviceCertificateStatus } from '../models/DeviceCertificate';
import { Device, DeviceStatus } from '../models/Device';
import { decodeCsrToPem } from '../utils/csr';

export interface LifecycleDeps {
  caService: CAService;
  recoveryCodeService: RecoveryCodeService;
}

const reissueLimiter = rateLimit({
  windowMs: parseInt(process.env.RECOVERY_REISSUE_WINDOW_MS || '900000', 10),
  max: parseInt(process.env.RECOVERY_REISSUE_MAX_PER_IP || '60', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests', code: 'IP_RATE_LIMITED', timestamp: new Date().toISOString() }
});

function httpStatusForRecoveryError(code: string): number {
  switch (code) {
    case 'CODE_EXPIRED':
      return 410;
    case 'RATE_LIMITED':
      return 429;
    case 'REDIS_UNAVAILABLE':
      return 503;
    default:
      return 400;
  }
}

/**
 * Notifies the website (Next.js / dashboard) that factory-reset recovery finished.
 * Set RECOVERY_WEBHOOK_URL to your backend route that emails or updates UI for the user.
 */
async function postRecoveryWebhook(deviceId: string): Promise<void> {
  const url = process.env.RECOVERY_WEBHOOK_URL?.trim();
  if (!url) {
    logger.warn('recovery complete but RECOVERY_WEBHOOK_URL is not set; website will not be notified', { deviceId });
    return;
  }
  try {
    const payload = JSON.stringify({
      event: 'recovery_complete',
      device_id: deviceId,
      status: 'ONLINE'
    });
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      signal: ac.signal
    });
    clearTimeout(t);
    if (!res.ok) {
      logger.warn('recovery webhook returned non-OK status', { deviceId, status: res.status });
    } else {
      logger.info('recovery webhook notified website', { deviceId });
    }
  } catch (e: unknown) {
    logger.warn('recovery webhook failed', { deviceId, error: e instanceof Error ? e.message : String(e) });
  }
}

export function createLifecycleRoutes(deps: LifecycleDeps): Router {
  const router = Router();
  const { caService, recoveryCodeService } = deps;

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
   * POST /api/v1/certificates/reissue
   * Body: { device_id: string, csr: string, recovery_code: string }
   * Requires a valid recovery code (from POST /api/v1/recovery/generate-code). No user JWT.
   */
  router.post('/certificates/reissue', reissueLimiter, async (req: Request, res: Response) => {
    try {
      const rawDeviceId = (req.body as any)?.device_id;
      if (typeof rawDeviceId !== 'string' || rawDeviceId.trim().length === 0) {
        res.status(400).json({ success: false, error: 'device_id is required', code: 'DEVICE_ID_REQUIRED', timestamp: new Date().toISOString() });
        return;
      }

      const rawCode = (req.body as any)?.recovery_code;
      if (typeof rawCode !== 'string' || rawCode.trim().length === 0) {
        res.status(400).json({
          success: false,
          error: 'recovery_code is required to obtain a certificate from this endpoint',
          code: 'RECOVERY_CODE_REQUIRED',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const requestedDeviceId = rawDeviceId.trim();
      const recoveryCode = rawCode.replace(/\s+/g, '').trim();
      logger.info('recovery reissue request received', { requestedDeviceId });

      if (!recoveryCodeService.isAvailable()) {
        res.status(503).json({
          success: false,
          error: 'Recovery storage unavailable',
          code: 'REDIS_UNAVAILABLE',
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Canonicalize to the exact device id stored in MongoDB (Device.clientId).
      let device = await Device.findOne({ clientId: requestedDeviceId });
      if (!device) {
        res.status(404).json({ success: false, error: 'Device not found', code: 'DEVICE_NOT_FOUND', timestamp: new Date().toISOString() });
        return;
      }

      const deviceId = device.clientId;
      logger.info('recovery reissue resolved device', { requestedDeviceId, deviceId });

      if (!device.userId) {
        res.status(400).json({
          success: false,
          error: 'Device has no owner; cannot issue certificate',
          code: 'DEVICE_USER_MISSING',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const userId = String(device.userId);

      const v = await recoveryCodeService.verifyCode(deviceId, recoveryCode);
      if (!v.ok) {
        logger.warn('recovery reissue: code validation failed', { deviceId, error: v.error });
        res.status(httpStatusForRecoveryError(v.error)).json({
          success: false,
          error: v.message,
          code: v.error,
          timestamp: new Date().toISOString()
        });
        return;
      }

      let csrPem: string;
      try {
        csrPem = decodeCsrToPem((req.body as any)?.csr ?? (req.body as any)?.CSR);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        res.status(400).json({ success: false, error: msg, code: 'CSR_INVALID', timestamp: new Date().toISOString() });
        return;
      }

      try {
        await caService.revokeAllDeviceCertificates(deviceId);
        const certDoc = await caService.signCSR(csrPem, deviceId, userId, { slot: 'primary', allowReplacePrimary: true });

        await recoveryCodeService.markUsed(deviceId);

        await Device.updateOne(
          { clientId: deviceId },
          { $set: { status: DeviceStatus.ACTIVE, errorMessage: undefined } }
        );

        await postRecoveryWebhook(deviceId);

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
      } catch (certError: unknown) {
        if (certError instanceof DeviceAlreadyHasCertificateError) {
          logger.warn('reissue 409: device already has active certificate', { deviceId, certificateId: certError.certificateId });
          res.status(409).json({
            success: false,
            error: certError.message,
            code: 'DEVICE_HAS_ACTIVE_CERTIFICATE',
            certificateId: certError.certificateId,
            timestamp: new Date().toISOString()
          });
          return;
        }
        if (certError instanceof UnsupportedCSRKeyTypeError) {
          logger.warn('reissue 400: unsupported CSR key type', { deviceId, error: certError.message });
          res.status(400).json({
            success: false,
            error: certError.message,
            code: 'UNSUPPORTED_CSR_KEY_TYPE',
            timestamp: new Date().toISOString()
          });
          return;
        }
        const certErrMsg = certError instanceof Error ? certError.message : 'Unknown error';
        const isCsrValidation =
          certErrMsg.includes('not found i745 554n CSR') ||
          certErrMsg.includes('Invalid CSR signature') ||
          certErrMsg.includes('does not contain a public key') ||
          certErrMsg.includes('did not match expected format');
        if (isCsrValidation) {
          const code = certErrMsg.includes('did not match expected format') ? 'INVALID_CSR_DEVICE_ID' : 'INVALID_CSR';
          logger.warn('reissue 400: CSR validation failed', { deviceId, error: certErrMsg });
          res.status(400).json({
            success: false,
            error: certErrMsg,
            code,
            timestamp: new Date().toISOString()
          });
          return;
        }
        throw certError;
      }
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('reissue failed', { error: msg });
      res.status(500).json({ success: false, error: 'Internal server error', code: 'REISSUE_FAILED', timestamp: new Date().toISOString() });
    }
  });

  return router;
}
