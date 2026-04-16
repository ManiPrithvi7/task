import type { NextFunction, Request, Response } from 'express';
import * as crypto from 'crypto';
import { DeviceCertificate, DeviceCertificateStatus } from '../models/DeviceCertificate';
import { deviceIdFromCertPem } from '../utils/deviceKeys';

export type MtlsCertSlot = 'primary' | 'staging';

function firstHeader(req: Request, headerName: string): string | null {
  const v = req.headers[headerName.toLowerCase()];
  if (!v) return null;
  if (Array.isArray(v)) return v[0] ?? null;
  return String(v);
}

/**
 * Best-effort decode of forwarded client cert header values:
 * - some proxies URL-encode the PEM
 * - some escape newlines as \\n
 * - some wrap the PEM in quotes
 */
function normalizeForwardedPem(raw: string): string {
  let s = raw.trim();
  if (!s) return s;
  try {
    // If URL-encoded PEM, decode it.
    if (/%2D%2D%2D%2D%2DBEGIN/i.test(s) || /%0A/i.test(s)) {
      s = decodeURIComponent(s);
    }
  } catch {
    // ignore decode errors; fall back to raw
  }
  // Strip surrounding quotes added by some proxies
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  // Normalize escaped newlines
  s = s.replace(/\\n/g, '\n');
  return s;
}

function parseCommonNameFromX509Subject(subject: string): string | null {
  const m = String(subject).match(/CN\s*=\s*([^,\n]+)/i);
  return m ? m[1].trim() : null;
}

export interface MtlsIdentity {
  deviceId: string;
  cn: string;
  fingerprint256: string;
  pem?: string;
}

function extractMtlsIdentityFromNativeTls(req: Request): MtlsIdentity | null {
  try {
    const anySocket: any = (req as any).socket || (req as any).connection;
    if (!anySocket || typeof anySocket.getPeerCertificate !== 'function') return null;

    // `getPeerCertificate(true)` returns full chain, but the leaf is enough for CN/deviceId.
    const peer = anySocket.getPeerCertificate(true);
    if (!peer || !peer.raw) return null;

    const x509 = new crypto.X509Certificate(peer.raw);
    const cn = parseCommonNameFromX509Subject(x509.subject) || '';
    const pem = x509.toString();
    const deviceId = deviceIdFromCertPem(pem);
    if (!deviceId) return null;

    return {
      deviceId,
      cn,
      fingerprint256: x509.fingerprint256,
      pem
    };
  } catch {
    return null;
  }
}

export function extractMtlsIdentityFromProxy(req: Request): MtlsIdentity | null {
  // Configurable header names (defaults cover common setups).
  const certHeaderName = (process.env.MTLS_CLIENT_CERT_HEADER || 'x-forwarded-client-cert').toLowerCase();
  const cnHeaderName = (process.env.MTLS_CLIENT_CN_HEADER || '').toLowerCase();

  const certHeader = firstHeader(req, certHeaderName);
  if (certHeader && certHeader.trim()) {
    const pem = normalizeForwardedPem(certHeader);
    try {
      const x509 = new crypto.X509Certificate(pem);
      const cn = parseCommonNameFromX509Subject(x509.subject) || '';
      const deviceId = deviceIdFromCertPem(pem);
      if (!deviceId) return null;
      return {
        deviceId,
        cn,
        fingerprint256: x509.fingerprint256,
        pem
      };
    } catch {
      return null;
    }
  }

  // Fallback: if deployment forwards CN directly (less secure; trust boundary is the proxy)
  if (cnHeaderName) {
    const cnOnly = firstHeader(req, cnHeaderName);
    if (cnOnly && cnOnly.trim()) {
      const cn = cnOnly.trim();
      const acceptCnAsDeviceId = process.env.MTLS_CN_IS_DEVICE_ID === 'true';
      if (acceptCnAsDeviceId) {
        return { deviceId: cn, cn, fingerprint256: '' };
      }
    }
  }

  // Native HTTPS mTLS fallback (when Node terminates TLS and requests client certs)
  return extractMtlsIdentityFromNativeTls(req);
}

async function findActiveCertForSlots(deviceId: string, allowedSlots: MtlsCertSlot[]): Promise<any | null> {
  const now = new Date();

  // Slot field does not exist yet pre-migration. Treat missing slot as 'primary'.
  const slotQuery =
    allowedSlots.length > 0
      ? {
          $or: [
            { slot: { $in: allowedSlots } },
            ...(allowedSlots.includes('primary') ? [{ slot: { $exists: false } }] : [])
          ]
        }
      : {};

  return DeviceCertificate.findOne({
    device_id: deviceId,
    status: DeviceCertificateStatus.active,
    expires_at: { $gt: now },
    ...(slotQuery as any)
  });
}

export function requireMtlsDeviceCert(opts?: { allowedSlots?: MtlsCertSlot[] }) {
  const allowedSlots = opts?.allowedSlots ?? (['primary', 'staging'] as MtlsCertSlot[]);

  return async (req: Request, res: Response, next: NextFunction) => {
    const identity = extractMtlsIdentityFromProxy(req);
    if (!identity) {
      res.status(401).json({ success: false, error: 'mTLS required', code: 'MTLS_REQUIRED' });
      return;
    }

    const certDoc = await findActiveCertForSlots(identity.deviceId, allowedSlots);
    if (!certDoc) {
      res.status(403).json({
        success: false,
        error: 'No active certificate found for device',
        code: 'CERT_NOT_ACTIVE',
        device_id: identity.deviceId
      });
      return;
    }

    (req as any).deviceId = identity.deviceId;
    (req as any).mtls = {
      cn: identity.cn,
      fingerprint256: identity.fingerprint256,
      slot: (certDoc as any).slot || 'primary'
    };

    next();
  };
}

