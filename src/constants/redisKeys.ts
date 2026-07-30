/** Shared Redis key patterns for proofmqtt services. */

const keyPrefix = process.env.REDIS_KEY_PREFIX?.trim() || 'proof-mqtt:';

export const REDIS_KEYS = {
  /** Per-device state hash (string → hash migration target). */
  deviceHash: (deviceId: string) => `proof.mqtt:device:${deviceId}`,

  /** Active device SET for restart hydration. */
  activeDevices: 'proof.mqtt:active:devices',

  /** Attention queue — keep Redis-backed. */
  priorityZset: 'priority_zset',

  /** Stub only — writer not wired; EXISTS used by poller filter. */
  igPowerSave: (deviceId: string) => `ig:power_save:${deviceId}`,

  /** Canonical GMB review count by location (not device). */
  gmbReviews: (locationId: string) => `gmb:reviews:${locationId}`,

  /** @deprecated Phase 5 — replaced by local circuit gate */
  circuitBlockedUntil: 'instagram:circuit:blocked_until',

  /** @deprecated Phase 5 — data moves to device hash + runtime cache */
  deviceFollowers: (deviceId: string) => `device:followers:${deviceId}`,

  /** @deprecated Phase 5 — replaced by local backoff */
  deviceFetchHistory: (deviceId: string) => `device:fetch_history:${deviceId}`,

  /** @deprecated Phase 5 — replaced by local dedupe */
  fetchDedupe: (deviceId: string) => `ig:fetch_dedupe:${deviceId}`,

  /** @deprecated Phase 5 — replaced by local budget tracker */
  globalFetchBudget: (minuteSlot: number) => `ig:poll:global_fetch_budget:${minuteSlot}`,

  /** @deprecated Phase 5 — replaced by local fair offset */
  backgroundFairnessOffset: 'ig:bg:fair_offset',

  /** @deprecated Phase 5 — runtime cache only */
  igLastPub: (deviceId: string) => `ig:last_pub:${deviceId}`,

  /** OTA / recovery — manually prefixed where used. */
  otaKeyPrefix: keyPrefix
} as const;
