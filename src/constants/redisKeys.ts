/** Shared Redis key patterns for proofmqtt services. */

const keyPrefix = process.env.REDIS_KEY_PREFIX?.trim() || 'proof-mqtt:';

export const REDIS_KEYS = {
  /** Per-device state hash (string → hash migration target). */
  deviceHash: (deviceId: string) => `proof.mqtt:device:${deviceId}`,

  /** Active device SET for restart hydration. */
  activeDevices: 'proof.mqtt:active:devices',

  /** Attention queue — keep Redis-backed. */
  priorityZset: 'priority_zset',

  /** OTA global config HASH (mirrors Mongo FirmwareRelease). */
  otaActiveRelease: `${keyPrefix}ota:active_release`,

  /** Provisioning token HASH. */
  provToken: (token: string) => `prov:${token}`,

  /** GMB webhook dedupe. */
  webhookDedupe: (key: string) => `webhook:dedupe:${key}`,

  /** Canonical GMB review count by location (not device). */
  gmbReviews: (locationId: string) => `gmb:reviews:${locationId}`,

  /** CSR rate limiting. */
  csrGlobal: (minute: string) => `csr:global:${minute}`,
  csrIp: (ip: string) => `csr:ip:${ip}`,

  /** Factory reset recovery sessions. */
  recoverySession: (deviceId: string) => `${keyPrefix}recovery:session:${deviceId}`,

  /** Legacy followers STRING — dual-read only during hash migration. */
  deviceFollowers: (deviceId: string) => `device:followers:${deviceId}`,

  /** Legacy IG fetch history ZSET — dual-read/cleanup only; polling moved to local backoff. */
  deviceFetchHistory: (deviceId: string) => `device:fetch_history:${deviceId}`,

  /** OTA / recovery — manually prefixed where used. */
  otaKeyPrefix: keyPrefix
} as const;
