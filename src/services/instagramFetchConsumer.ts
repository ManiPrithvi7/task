/**
 * Instagram Fetch Consumer
 *
 * Kafka Consumer Group: "instagram-fetch-consumers"
 * Topic consumed:  instagram-fetch-requests
 * Topic produced:  instagram-fetch-results
 *
 * For each incoming fetch request:
 *   1. Look up device's Instagram token + accountId in Redis
 *   2. Call Instagram Graph API (with rate limiting + retry)
 *   3. Write raw metrics to InfluxDB (instagram_metrics)
 *   4. Write audit entry to InfluxDB (instagram_fetch_audit)
 *   5. Publish result to instagram-fetch-results topic
 */

import {
    Kafka, Consumer, Producer, Partitioners,
    logLevel, SASLOptions, EachMessagePayload
} from 'kafkajs';
import { logger } from '../utils/logger';
import { connectWithRetry } from '../utils/kafkaRetry';
import { KafkaConfig } from '../config';
import { fetchInstagramMetrics, InstagramFetchResult } from './instagramApiClient';
import { getInfluxService } from './influxService';
import { Point } from '@influxdata/influxdb-client';
import { getActiveDeviceCache } from './deviceService';
import { InstagramRedisStore } from './instagramRedisStore';

export const FETCH_REQUESTS_TOPIC = 'instagram-fetch-requests';
export const FETCH_RESULTS_TOPIC = 'instagram-fetch-results';
export const INSTAGRAM_ERRORS_TOPIC = 'instagram-errors';
export const CONSUMER_GROUP = 'instagram-fetch-consumers';

export interface FetchRequest {
    deviceId: string;
    trigger: 'new_connection' | 'scheduled' | 'retry';
    fetchType?: 'media' | 'insights' | 'both';
    priority?: 'high' | 'normal' | 'low';
    requested_at: string;
    force_refresh?: boolean;
    userId?: string;
}

export interface FetchResult {
    deviceId: string;
    success: boolean;
    fetched_at: string;
    data?: {
        followers_count: number;
        // NOTE: Insight fields commented out — not needed right now
        // followers_delta_24h: number;
        // impressions_day: number;
        // impressions_week: number;
        // reach_day: number;
        // reach_week: number;
        // profile_views: number;
        // media_count: number;
        // engagement_rate: number;
    };
    error?: string;
    metadata: {
        api_response_time_ms: number;
        instagram_account_id: string;
        cache_hit: boolean;
        trigger: string;
    };
}

export class InstagramFetchConsumer {
    private kafka: Kafka;
    private consumer: Consumer;
    private producer: Producer;
    private config: KafkaConfig;
    private running = false;
    private influxBuffer: Point[] = [];
    private influxFlushTimer: NodeJS.Timeout | null = null;
    private redisStore = new InstagramRedisStore();

    constructor(config: KafkaConfig) {
        this.config = config;
        this.kafka = new Kafka({
            clientId: `${config.clientId}-instagram-fetch`,
            brokers: config.brokers,
            ssl: config.ssl || undefined,
            sasl: config.sasl as SASLOptions | undefined,
            logLevel: logLevel.WARN,
            connectionTimeout: 10000,
            requestTimeout: 10000
        });

        this.consumer = this.kafka.consumer({ groupId: CONSUMER_GROUP });
        this.producer = this.kafka.producer({
            createPartitioner: Partitioners.LegacyPartitioner,
            allowAutoTopicCreation: true
        });
    }

    async start(): Promise<void> {
        if (this.running) return;

        await connectWithRetry(() => this.consumer.connect(), 'Instagram fetch consumer');
        await connectWithRetry(() => this.producer.connect(), 'Instagram fetch producer');

        await this.consumer.subscribe({
            topics: [FETCH_REQUESTS_TOPIC],
            fromBeginning: false
        });

        this.running = true;
        logger.info('📸 [INSTAGRAM_CONSUMER] Started', {
            group: CONSUMER_GROUP,
            topic: FETCH_REQUESTS_TOPIC
        });

        this.influxFlushTimer = setInterval(() => {
            this.flushInfluxBuffer().catch(() => {});
        }, 5000);

        await this.consumer.run({
            eachMessage: async ({ message }: EachMessagePayload) => {
                const raw = message.value?.toString();
                if (!raw) return;

                let request: FetchRequest;
                try {
                    request = JSON.parse(raw);
                } catch {
                    logger.warn('[INSTAGRAM_CONSUMER] Failed to parse message', { raw: raw.slice(0, 200) });
                    return;
                }

                await this.handleFetchRequest(request);
            }
        });
    }

    private async handleFetchRequest(request: FetchRequest): Promise<void> {
        const { deviceId, trigger } = request;
        logger.info('📩 [INSTAGRAM_CONSUMER] Processing fetch request', { deviceId, trigger });

        // ── Lookup token + Instagram accountId from Redis ─────────────────────
        const auth = await this.redisStore.getDeviceAuth(deviceId);
        if (!auth) {
            const error = 'Missing Instagram token/account id in Redis';
            await this.publishDlq({ deviceId, trigger, error });
            await this.publishResult({
                deviceId,
                success: false,
                fetched_at: new Date().toISOString(),
                error,
                metadata: {
                    api_response_time_ms: 0,
                    instagram_account_id: '',
                    cache_hit: false,
                    trigger
                }
            });
            return;
        }

        const activeDevice = await getActiveDeviceCache().getDevice(deviceId);
        const userId = activeDevice?.userId || 'unknown';

        // ── Fetch from Instagram Graph API ────────────────────────────────────
        const result: InstagramFetchResult = await fetchInstagramMetrics(deviceId, {
            accessToken: auth.accessToken,
            instagramAccountId: auth.instagramAccountId,
            userId
        });

        // ── Write to InfluxDB ─────────────────────────────────────────────────
        const influx = getInfluxService();
        logger.info('[INSTAGRAM_CONSUMER] Attempting InfluxDB write', {
            hasInfluxInstance: !!influx,
            isSuccess: result.success,
            hasMetrics: !!result.metrics
        });

        if (influx && result.success && result.metrics) {
            try {
                const writeApi = (influx as unknown as { writeApi: { writePoint: (p: Point) => void; flush: () => Promise<void> } }).writeApi;

                const metricsPoint = new Point('instagram_metrics')
                    .tag('device_id', deviceId)
                    .tag('user_id', userId)
                    .tag('instagram_account_id', result.instagramAccountId)
                    // Only writing followers_count for now
                    .intField('followers', result.metrics.followers_count)
                    // NOTE: Insight fields commented out — not needed right now
                    // .intField('followers_delta_24h', result.metrics.followers_delta_24h)
                    // .intField('impressions_day', result.metrics.impressions_day)
                    // .intField('impressions_week', result.metrics.impressions_week)
                    // .intField('reach_day', result.metrics.reach_day)
                    // .intField('reach_week', result.metrics.reach_week)
                    // .intField('profile_views', result.metrics.profile_views)
                    // .intField('media_count', result.metrics.media_count)
                    // .floatField('engagement_rate', result.metrics.engagement_rate)
                    .timestamp(new Date());

                const auditPoint = new Point('instagram_fetch_audit')
                    .tag('device_id', deviceId)
                    .tag('status', 'success')
                    .tag('trigger', trigger)
                    .intField('response_time_ms', result.apiResponseTimeMs)
                    .intField('retry_count', 0)
                    .timestamp(new Date());

                // Buffer points; flush in batches (timer + size threshold)
                this.influxBuffer.push(metricsPoint, auditPoint);
                if (this.influxBuffer.length >= 100) {
                    await this.flushInfluxBuffer();
                }

                logger.info('[INSTAGRAM_CONSUMER] 🟢 Metrics written to InfluxDB successfully', { deviceId });
            } catch (err: unknown) {
                logger.error('[INSTAGRAM_CONSUMER] 🔴 InfluxDB write failed', {
                    deviceId,
                    error: err instanceof Error ? err.message : String(err)
                });
            }
        }

        // Write audit for failure case
        if (influx && !result.success) {
            try {
                const writeApi = (influx as unknown as { writeApi: { writePoint: (p: Point) => void; flush: () => Promise<void> } }).writeApi;
                const auditPoint = new Point('instagram_fetch_audit')
                    .tag('device_id', deviceId)
                    .tag('status', 'failure')
                    .tag('trigger', trigger)
                    .intField('response_time_ms', result.apiResponseTimeMs)
                    .stringField('error_message', result.error || 'unknown')
                    .timestamp(new Date());

                this.influxBuffer.push(auditPoint);
                if (this.influxBuffer.length >= 100) {
                    await this.flushInfluxBuffer();
                }
            } catch { /* swallow */ }
        }

        // ── Publish result to instagram-fetch-results ─────────────────────────
        const fetchResult: FetchResult = {
            deviceId,
            success: result.success,
            fetched_at: new Date().toISOString(),
            ...(result.success && result.metrics
                ? { data: { followers_count: result.metrics.followers_count } }
                : { error: result.error }),
            metadata: {
                api_response_time_ms: result.apiResponseTimeMs,
                instagram_account_id: result.instagramAccountId,
                cache_hit: result.cacheHit,
                trigger
            }
        };

        if (!result.success) {
            await this.publishDlq({
                deviceId,
                trigger,
                error: result.error || 'unknown',
                errorCode: result.errorCode
            });
        }

        await this.publishResult(fetchResult);
    }

    private async flushInfluxBuffer(): Promise<void> {
        const influx = getInfluxService();
        if (!influx) return;
        if (this.influxBuffer.length === 0) return;

        const points = this.influxBuffer.splice(0, this.influxBuffer.length);
        try {
            const writeApi = (influx as unknown as { writeApi: { writePoints: (p: Point[]) => void; flush: () => Promise<void> } }).writeApi;
            writeApi.writePoints(points);
            await writeApi.flush();
        } catch {
            // If flush fails, drop this batch (avoid unbounded memory growth)
        }
    }

    private async publishDlq(payload: {
        deviceId: string;
        trigger: string;
        error: string;
        errorCode?: string | number;
    }): Promise<void> {
        try {
            await this.producer.send({
                topic: INSTAGRAM_ERRORS_TOPIC,
                messages: [{
                    key: payload.deviceId,
                    value: JSON.stringify({
                        ...payload,
                        timestamp: new Date().toISOString(),
                        service: 'mqtt-publisher-lite'
                    })
                }]
            });
        } catch {
            // swallow; DLQ is best-effort
        }
    }

    private async publishResult(result: FetchResult): Promise<void> {
        try {
            await this.producer.send({
                topic: FETCH_RESULTS_TOPIC,
                messages: [{
                    key: result.deviceId,
                    value: JSON.stringify(result)
                }]
            });
            logger.debug('[INSTAGRAM_CONSUMER] Result published', {
                deviceId: result.deviceId,
                success: result.success
            });
        } catch (err: unknown) {
            logger.error('[INSTAGRAM_CONSUMER] Failed to publish result', {
                deviceId: result.deviceId,
                error: err instanceof Error ? err.message : String(err)
            });
        }
    }

    async stop(): Promise<void> {
        this.running = false;
        if (this.influxFlushTimer) {
            clearInterval(this.influxFlushTimer);
            this.influxFlushTimer = null;
        }
        await this.flushInfluxBuffer();
        await this.consumer.disconnect();
        await this.producer.disconnect();
        logger.info('[INSTAGRAM_CONSUMER] Stopped');
    }
}

let _instance: InstagramFetchConsumer | null = null;

export function createInstagramFetchConsumer(config: KafkaConfig): InstagramFetchConsumer {
    _instance = new InstagramFetchConsumer(config);
    return _instance;
}

export function getInstagramFetchConsumer(): InstagramFetchConsumer | null {
    return _instance;
}
