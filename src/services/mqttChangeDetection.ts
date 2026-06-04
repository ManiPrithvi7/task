import { createHash } from 'crypto';
import { getRedisService } from './redisService';
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
  const redisSvc = getRedisService();
  if (!redisSvc?.isRedisConnected()) return false;

  try {
    const deleted = await redisSvc.getClient().del(publishHashRedisKey(deviceId, topic));
    return deleted > 0;
  } catch {
    return false;
  }
}

/** Clears all screen dedupe hashes for a device (call on LWT disconnect). */
export async function clearAllPublishHashesForDevice(deviceId: string): Promise<number> {
  const redisSvc = getRedisService();
  if (!redisSvc?.isRedisConnected()) return 0;

  const client = redisSvc.getClient();
  const pattern = `msg:last_hash:${deviceId}:*`;
  let cursor = 0;
  let removed = 0;

  try {
    do {
      const reply = await client.scan(cursor, { MATCH: pattern, COUNT: 100 });
      cursor = typeof reply.cursor === 'number' ? reply.cursor : Number(reply.cursor);
      const keys = reply.keys;
      if (keys.length > 0) {
        removed += await client.del(keys);
      }
    } while (cursor !== 0);
  } catch {
    return removed;
  }

  return removed;
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

  const redisSvc = getRedisService();
  const doPublish = () =>
    opts.mqttClient.publishWithRetry(
      { topic: opts.topic, payload: opts.payload, qos, retain },
      { deviceId: opts.deviceId, source: 'publish_if_changed' }
    );

  if (!redisSvc?.isRedisConnected()) {
    await doPublish();
    return { published: true, reason: 'no_redis' };
  }

  const client = redisSvc.getClient();
  const newHash = hashPayload(opts.hashInput);
  const redisKey = publishHashRedisKey(opts.deviceId, opts.topic);
  const lastHash = await client.get(redisKey);

  if (lastHash && lastHash === newHash) {
    return { published: false, reason: 'unchanged' };
  }

  await doPublish();
  await client.set(redisKey, newHash, { EX: ttl });
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

  const redisSvc = getRedisService();
  if (!redisSvc?.isRedisConnected()) return;

  const newHash = hashPayload(opts.hashInput);
  await redisSvc.getClient().set(publishHashRedisKey(opts.deviceId, opts.topic), newHash, { EX: ttl });
}

