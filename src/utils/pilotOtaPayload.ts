export type PilotBootPayload = {
  fwVersion?: string;
  bootType?: string;
  ipAddress?: string;
  timestamp?: Date;
  isPilotRegistration: boolean;
};

export type PilotOtaFailPayload = {
  version?: string;
  reason?: string;
  timestamp?: Date;
};

function metadataRecord(message: unknown): Record<string, unknown> | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const meta = (message as { metadata?: unknown }).metadata;
  return meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : undefined;
}

function readString(obj: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = obj?.[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export function parsePilotBootPayload(message: unknown): PilotBootPayload {
  const meta = metadataRecord(message);
  const type =
    message && typeof message === 'object'
      ? String((message as { type?: string }).type || '')
      : '';

  const fwVersion =
    readString(meta, 'fw_version') ||
    (message && typeof message === 'object'
      ? readString(message as Record<string, unknown>, 'appVersion') ||
        readString(message as Record<string, unknown>, 'app_version') ||
        readString(meta, 'appVersion')
      : undefined);

  const rawTs =
    message && typeof message === 'object' ? (message as { timestamp?: string }).timestamp : undefined;

  return {
    fwVersion,
    bootType: readString(meta, 'boot_type'),
    ipAddress: readString(meta, 'ipAddress'),
    timestamp: rawTs ? new Date(rawTs) : undefined,
    isPilotRegistration: type === 'device_registration'
  };
}

export function normalizeOtaEventKey(payload: { type?: string; event?: string; status?: string }): string | undefined {
  const raw = payload.type || payload.event || payload.status;
  if (!raw) return undefined;
  // Pilot hyphenated types → underscore handlers
  return raw.replace(/-/g, '_');
}

export function parsePilotOtaFailPayload(message: unknown): PilotOtaFailPayload {
  const meta = metadataRecord(message);
  const top =
    message && typeof message === 'object' ? (message as Record<string, unknown>) : undefined;

  const version =
    readString(meta, 'fw_version') ||
    readString(top, 'version') ||
    readString(top, 'attempted_version');

  let reason = readString(meta, 'reason') || readString(top, 'reason');
  const reasons = top?.reasons;
  if (!reason && Array.isArray(reasons)) {
    reason = reasons.filter((r) => typeof r === 'string').join('; ') || undefined;
  }

  const rawTs = top?.timestamp;
  return {
    version,
    reason,
    timestamp: typeof rawTs === 'string' ? new Date(rawTs) : undefined
  };
}

export function isPilotOtaStatusEvent(eventKey: string | undefined): boolean {
  if (!eventKey) return false;
  return eventKey.startsWith('ota_') || eventKey === 'ota_fail';
}
