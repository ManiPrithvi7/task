import { createHash } from 'crypto';
import { getLocalPublishHashCache } from './localCaches';
import type { MqttClientManager } from '../servers/mqttClient';

function stableJson(value: unknown): string {
  // Enough determinism for our payload objects (plain JSON).
  return JSON.stringify(value);
}

function hashPayload(value: unknown): string {
  return createHash('md5').update(stableJson(value)).digest('hex');
}

/** Redis key for `publishIfChanged` dedupe (must match on clear). */
export function publishHashRedisKey(deviceId: string, topic: string): string {
  return `msg:last_hash:${deviceId}:${topic}`;
}

export async function clearPublishHash(deviceId: string, topic: string): Promise<boolean> {
  return getLocalPublishHashCache().del(deviceId, topic);
}

/** Clears all screen dedupe hashes for a device (call on LWT disconnect). */
export async function clearAllPublishHashesForDevice(deviceId: string): Promise<number> {
  return getLocalPublishHashCache().clear(deviceId);
}

export async function publishIfChanged(opts: {
  deviceId: string;
  topic: string;
  /** The object that represents "meaningful change" (exclude timestamps). */
  hashInput: unknown;
  /** The exact payload string to publish if changed. */
  payload: string;
  mqttClient: MqttClientManager;
  qos?: 0 | 1 | 2;
  retain?: boolean;
  /** TTL for stored hash (seconds). */
  hashTtlSec?: number;
}): Promise<{ published: boolean; reason: 'changed' | 'unchanged' | 'no_redis' }> {
  const qos = opts.qos ?? 1;
  const retain = opts.retain ?? false;
  const ttl = opts.hashTtlSec ?? 86400;

  const doPublish = () =>
    opts.mqttClient.publishWithRetry(
      { topic: opts.topic, payload: opts.payload, qos, retain },
      { deviceId: opts.deviceId, source: 'publish_if_changed' }
    );

  const cache = getLocalPublishHashCache();
  const newHash = hashPayload(opts.hashInput);
  const lastHash = cache.get(opts.deviceId, opts.topic);

  if (lastHash && lastHash === newHash) {
    return { published: false, reason: 'unchanged' };
  }

  await doPublish();
  cache.set(opts.deviceId, opts.topic, newHash, ttl * 1000);
  return { published: true, reason: 'changed' };
}

/** Always MQTT-publish (e.g. device reconnect); updates dedupe hash so the 60s cycle can still skip unchanged. */
export async function publishForce(opts: {
  deviceId: string;
  topic: string;
  hashInput: unknown;
  payload: string;
  mqttClient: MqttClientManager;
  qos?: 0 | 1 | 2;
  retain?: boolean;
  hashTtlSec?: number;
  source?: string;
}): Promise<void> {
  const qos = opts.qos ?? 1;
  const retain = opts.retain ?? false;
  const ttl = opts.hashTtlSec ?? 86400;

  await opts.mqttClient.publishWithRetry(
    { topic: opts.topic, payload: opts.payload, qos, retain },
    { deviceId: opts.deviceId, source: opts.source ?? 'publish_force' }
  );

  const newHash = hashPayload(opts.hashInput);
  getLocalPublishHashCache().set(opts.deviceId, opts.topic, newHash, ttl * 1000);
}
