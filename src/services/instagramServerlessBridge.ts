/**
 * Calls external serverless (e.g. Vercel) to run Instagram Graph API fetches,
 * then applies audits / Influx / MQTT via instagramServerlessOutcome.
 */

import { logger } from '../utils/logger';
import type { InstagramServerlessConfig } from '../config';
import type { MqttClientManager } from '../servers/mqttClient';
import { InstagramCircuitBreaker } from './instagramCircuitBreaker';
import { getRedisService } from './redisService';
import {
  applyInstagramServerlessDeviceOutcome,
  type NormalizedDeviceFetchResult
} from './instagramServerlessOutcome';

export interface InstagramFetchInvoker {
  isConfigured(): boolean;
  invokeFetch(
    deviceIds: string[],
    opts: { trigger: 'attention' | 'scheduled'; correlationId?: string }
  ): Promise<boolean>;
}

function parseDeviceRow(raw: Record<string, unknown>, fallbackDeviceId?: string): NormalizedDeviceFetchResult | null {
  const deviceId =
    (typeof raw.deviceId === 'string' && raw.deviceId) ||
    (typeof raw.device_id === 'string' && raw.device_id) ||
    fallbackDeviceId;
  if (!deviceId) return null;

  const success = raw.success === true;
  const nested = raw.data && typeof raw.data === 'object' ? (raw.data as Record<string, unknown>) : null;
  const followers =
    typeof raw.followers_count === 'number'
      ? raw.followers_count
      : nested && typeof nested.followers_count === 'number'
        ? nested.followers_count
        : undefined;

  const igUsernameRaw =
    typeof raw.instagram_username === 'string'
      ? raw.instagram_username
      : nested && typeof nested.username === 'string'
        ? nested.username
        : nested && typeof nested.instagram_username === 'string'
          ? nested.instagram_username
          : undefined;

  const fetched_at =
    typeof raw.fetched_at === 'string'
      ? raw.fetched_at
      : typeof raw.timestamp === 'string'
        ? raw.timestamp
        : new Date().toISOString();

  return {
    deviceId,
    success,
    fetched_at,
    ...(followers !== undefined ? { followers_count: followers } : {}),
    ...(typeof igUsernameRaw === 'string' && igUsernameRaw.trim()
      ? { instagram_username: igUsernameRaw.trim() }
      : {}),
    ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
    ...(typeof raw.instagram_account_id === 'string' ? { instagram_account_id: raw.instagram_account_id } : {}),
    ...(typeof raw.api_response_time_ms === 'number' ? { api_response_time_ms: raw.api_response_time_ms } : {}),
    ...(typeof raw.cache_hit === 'boolean' ? { cache_hit: raw.cache_hit } : {}),
    ...(typeof raw.http_status === 'number' ? { http_status: raw.http_status } : {}),
    ...(typeof raw.retry_after_seconds === 'number' ? { retry_after_seconds: raw.retry_after_seconds } : {}),
    ...(raw.error_code !== undefined ? { error_code: raw.error_code as string | number } : {})
  };
}

function normalizeResponseBody(body: unknown, requestedIds: string[]): NormalizedDeviceFetchResult[] {
  if (!body || typeof body !== 'object') return [];

  const o = body as Record<string, unknown>;
  const out: NormalizedDeviceFetchResult[] = [];

  if (Array.isArray(o.results)) {
    for (const item of o.results) {
      if (item && typeof item === 'object') {
        const row = parseDeviceRow(item as Record<string, unknown>);
        if (row) out.push(row);
      }
    }
    return out;
  }

  if (o.results && typeof o.results === 'object' && !Array.isArray(o.results)) {
    const map = o.results as Record<string, unknown>;
    for (const [key, val] of Object.entries(map)) {
      if (val && typeof val === 'object') {
        const row = parseDeviceRow(val as Record<string, unknown>, key);
        if (row) out.push(row);
      }
    }
    return out;
  }

  if (typeof o.success === 'boolean' && requestedIds.length === 1) {
    const row = parseDeviceRow(o, requestedIds[0]);
    return row ? [row] : [];
  }

  return [];
}

async function maybeApplyGlobalCircuit(body: unknown): Promise<void> {
  if (!body || typeof body !== 'object') return;
  const secs = (body as { circuit_open_seconds?: unknown }).circuit_open_seconds;
  if (typeof secs !== 'number' || secs <= 0) return;
  try {
    const redisSvc = getRedisService();
    if (!redisSvc?.isRedisConnected()) return;
    const breaker = new InstagramCircuitBreaker(redisSvc.getClient());
    await breaker.open(Math.ceil(secs));
    logger.warn('[IG_SERVERLESS] Circuit opened from response payload', { seconds: secs });
  } catch {
    /* ignore */
  }
}

export class InstagramServerlessBridge implements InstagramFetchInvoker {
  constructor(
    private readonly cfg: InstagramServerlessConfig,
    private readonly mqttClient: MqttClientManager
  ) {}

  isConfigured(): boolean {
    return Boolean(this.cfg.fetchUrl?.trim());
  }

  async invokeFetch(
    deviceIds: string[],
    opts: { trigger: 'attention' | 'scheduled'; correlationId?: string }
  ): Promise<boolean> {
    if (!this.isConfigured() || deviceIds.length === 0) return false;

    const url = this.cfg.fetchUrl.trim();
    const timeoutMs = this.cfg.timeoutMs > 0 ? this.cfg.timeoutMs : 30_000;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(this.cfg.apiKey ? { 'x-api-key': this.cfg.apiKey } : {})
    };

    const body = JSON.stringify({
      deviceIds,
      trigger: opts.trigger,
      ...(opts.correlationId ? { correlation_id: opts.correlationId } : {})
    });

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err: unknown) {
      logger.warn('[IG_SERVERLESS] Fetch failed', {
        error: err instanceof Error ? err.message : String(err),
        deviceCount: deviceIds.length
      });
      return false;
    }

    if (response.status === 429) {
      let retryAfter = 60;
      try {
        const errBody = await response.json();
        if (errBody && typeof errBody === 'object' && typeof (errBody as { retry_after_seconds?: number }).retry_after_seconds === 'number') {
          retryAfter = Math.max(1, Math.floor((errBody as { retry_after_seconds: number }).retry_after_seconds));
        }
        await maybeApplyGlobalCircuit(errBody);
      } catch {
        /* use default */
      }
      try {
        const redisSvc = getRedisService();
        if (redisSvc?.isRedisConnected()) {
          await new InstagramCircuitBreaker(redisSvc.getClient()).open(retryAfter);
        }
      } catch {
        /* ignore */
      }
      logger.warn('[IG_SERVERLESS] HTTP 429 from serverless', { retryAfter });
      return false;
    }

    let parsed: unknown;
    try {
      const text = await response.text();
      parsed = text ? JSON.parse(text) : {};
    } catch {
      logger.warn('[IG_SERVERLESS] Invalid JSON response', { status: response.status });
      return false;
    }

    await maybeApplyGlobalCircuit(parsed);

    if (!response.ok) {
      logger.warn('[IG_SERVERLESS] Non-OK HTTP status', { status: response.status, body: parsed });
    }

    const rows = normalizeResponseBody(parsed, deviceIds);
    if (rows.length === 0) {
      logger.debug('[IG_SERVERLESS] No device rows in response', { requested: deviceIds.length, status: response.status });
      return response.ok;
    }

    const topicRoot = this.mqttClient.getTopicRoot();
    const triggerTag = opts.trigger;
    const cid =
      opts.correlationId && deviceIds.length === 1 && opts.trigger === 'attention'
        ? opts.correlationId
        : undefined;

    const allowed = new Set(deviceIds);
    let applied = 0;
    for (const row of rows) {
      if (!allowed.has(row.deviceId)) continue;
      await applyInstagramServerlessDeviceOutcome(row, this.mqttClient, topicRoot, triggerTag, cid);
      applied++;
    }

    return response.ok || applied > 0;
  }
}
