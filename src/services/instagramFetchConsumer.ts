/**
 * Instagram Fetch Consumer
 *
 * Kafka Consumer Group: "instagram-fetch-consumers"
 * Topic consumed:  instagram-fetch-requests
 * Topic produced:  instagram-fetch-results
 *
 * For each incoming fetch request:
 *   1. Look up device's Instagram social account in MongoDB
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
import { Social, Provider } from '../models/Social';
import { fetchInstagramMetrics, InstagramFetchResult } from './instagramApiClient';
import { getInfluxService } from './influxService';
import { getMongoService } from './mongoService';
import { Point } from '@influxdata/influxdb-client';

export const FETCH_REQUESTS_TOPIC = 'instagram-fetch-requests';
export const FETCH_RESULTS_TOPIC = 'instagram-fetch-results';
export const CONSUMER_GROUP = 'instagram-fetch-consumers';

export interface FetchRequest {
    deviceId: string;
    trigger: 'new_connection' | 'scheduled' | 'retry';
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
        const { deviceId, trigger, userId } = request;
        logger.info('📩 [INSTAGRAM_CONSUMER] Processing fetch request', { deviceId, trigger });

        // ── Lookup Instagram social account from MongoDB ──────────────────────
        let socialAccount: { accessToken: string; socialAccountId: string; userId: string } | null = null;
        try {
            const mongoService = getMongoService();
            const db = mongoService?.getDatabase();
            if (!db) throw new Error('Native MongoDB connection not available via MongoService');

            const mongoose = await import('mongoose');

            // Bypass Mongoose strict schema bug, try with ObjectId first
            let social = await db.collection('socials').findOne({
                provider: 'INSTAGRAM',
                ...(userId ? { userId: new mongoose.Types.ObjectId(userId) } : {})
            });
            // console.log({ social })
            // Fallback: try with the raw string
            if (!social && userId) {
                social = await db.collection('socials').findOne({
                    provider: 'INSTAGRAM',
                    userId: userId
                });
            }

            // Fallback: try different collection casing
            if (!social) {
                social = await db.collection('Social').findOne({
                    provider: 'INSTAGRAM',
                    ...(userId ? { userId: new mongoose.Types.ObjectId(userId) } : {})
                });
            }

            if (!social) {
                logger.warn('[INSTAGRAM_CONSUMER] No Instagram social account found', { deviceId, userId });
                await this.publishResult({
                    deviceId,
                    success: false,
                    fetched_at: new Date().toISOString(),
                    error: 'No Instagram account linked',
                    metadata: {
                        api_response_time_ms: 0,
                        instagram_account_id: '',
                        cache_hit: false,
                        trigger
                    }
                });
                return;
            }

            socialAccount = {
                accessToken: social.accessToken,
                socialAccountId: social.socialAccountId,
                userId: social.userId.toString()
            };
            console.log({ socialAccount })
        } catch (err: unknown) {
            logger.error('[INSTAGRAM_CONSUMER] MongoDB lookup failed', {
                deviceId,
                error: err instanceof Error ? err.message : String(err)
            });
            return;
        }

        // ── Fetch from Instagram Graph API ────────────────────────────────────
        const result: InstagramFetchResult = await fetchInstagramMetrics(deviceId, {
            accessToken: socialAccount.accessToken,
            instagramAccountId: socialAccount.socialAccountId,
            userId: socialAccount.userId
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
                    .tag('user_id', socialAccount.userId)
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

                writeApi.writePoint(metricsPoint);
                writeApi.writePoint(auditPoint);
                await writeApi.flush();

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

                writeApi.writePoint(auditPoint);
                await writeApi.flush();
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

        await this.publishResult(fetchResult);
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
