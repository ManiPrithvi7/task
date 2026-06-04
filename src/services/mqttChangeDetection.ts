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
  const redisKey = `msg:last_hash:${opts.deviceId}:${opts.topic}`;
  const lastHash = await client.get(redisKey);

  if (lastHash && lastHash === newHash) {
    return { published: false, reason: 'unchanged' };
  }

  await doPublish();
  await client.set(redisKey, newHash, { EX: ttl });
  return { published: true, reason: 'changed' };
}

