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
import { getMongoService } from './mongoService';
import { getRedisService } from './redisService';
import { InstagramCircuitBreaker } from './instagramCircuitBreaker';
import { InstagramFetchAudit } from '../models/InstagramFetchAudit';
import { REDIS_KEYS } from './instagramPollingLua';

export const FETCH_REQUESTS_TOPIC = 'instagram-fetch-requests';
export const FETCH_RESULTS_TOPIC = 'instagram-fetch-results';
export const CONSUMER_GROUP = 'instagram-fetch-consumers';

export interface FetchRequest {
    deviceId: string;
    trigger: 'new_connection' | 'scheduled' | 'retry' | 'attention';
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

    private async readCachedFollowers(deviceId: string): Promise<number | null> {
        const redisSvc = getRedisService();
        if (!redisSvc?.isRedisConnected()) return null;
        try {
            const raw = await redisSvc.getClient().get(REDIS_KEYS.deviceFollowers(deviceId));
            if (raw === null) return null;
            const n = parseInt(raw, 10);
            return Number.isNaN(n) ? null : n;
        } catch {
            return null;
        }
    }

    private async persistMongoFetchAudit(entry: {
        deviceId: string;
        oldFollowers: number | null;
        newFollowers: number | null;
        success: boolean;
        error?: string | null;
    }): Promise<void> {
        try {
            await InstagramFetchAudit.create({
                deviceId: entry.deviceId,
                oldFollowers: entry.oldFollowers,
                newFollowers: entry.newFollowers,
                fetchTimestamp: new Date(),
                success: entry.success,
                error: entry.error ?? null
            });
        } catch (err: unknown) {
            logger.warn('[INSTAGRAM_CONSUMER] Mongo instagram_fetch_audit insert failed', {
                deviceId: entry.deviceId,
                error: err instanceof Error ? err.message : String(err)
            });
        }
    }

    private async handleFetchRequest(request: FetchRequest): Promise<void> {
        const { deviceId, trigger, userId } = request;
        logger.info('📩 [INSTAGRAM_CONSUMER] Processing fetch request', { deviceId, trigger });

        const oldFollowers = await this.readCachedFollowers(deviceId);

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
                await this.persistMongoFetchAudit({
                    deviceId,
                    oldFollowers,
                    newFollowers: null,
                    success: false,
                    error: 'No Instagram account linked'
                });
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
        } catch (err: unknown) {
            logger.error('[INSTAGRAM_CONSUMER] MongoDB lookup failed', {
                deviceId,
                error: err instanceof Error ? err.message : String(err)
            });
            await this.persistMongoFetchAudit({
                deviceId,
                oldFollowers,
                newFollowers: null,
                success: false,
                error: `MongoDB lookup failed: ${err instanceof Error ? err.message : String(err)}`
            });
            return;
        }

        // ── Fetch from Instagram Graph API ────────────────────────────────────
        const result: InstagramFetchResult = await fetchInstagramMetrics(deviceId, {
            accessToken: socialAccount.accessToken,
            instagramAccountId: socialAccount.socialAccountId,
            userId: socialAccount.userId
        });

        const newFollowers = result.success && result.metrics ? result.metrics.followers_count : null;
        await this.persistMongoFetchAudit({
            deviceId,
            oldFollowers,
            newFollowers,
            success: result.success,
            error: result.success ? null : (result.error ?? null)
        });

        // ── Cross-instance circuit breaker (rate-limit protection) ────────────
        try {
            const redisSvc = getRedisService();
            if (redisSvc?.isRedisConnected()) {
                const breaker = new InstagramCircuitBreaker(redisSvc.getClient());

                if (!result.success && result.httpStatus === 429 && result.retryAfterSeconds != null) {
                    const secs = Math.max(1, Math.floor(result.retryAfterSeconds));
                    await breaker.open(secs);
                    logger.warn('[INSTAGRAM_CONSUMER] Circuit opened (HTTP 429 Retry-After)', {
                        deviceId,
                        retryAfterSeconds: secs
                    });
                } else {
                    const rateLimitCodes = new Set<string>(['4', '17', '32', 'RATE_LIMIT_GLOBAL', 'RATE_LIMIT_DEVICE', 'RATE_LIMIT_BURST']);
                    const code = result.errorCode !== undefined ? String(result.errorCode) : null;
                    if (!result.success && code && rateLimitCodes.has(code)) {
                        await breaker.open(60);
                        logger.warn('[INSTAGRAM_CONSUMER] Circuit opened due to API/throttle signals', {
                            deviceId,
                            code,
                            seconds: 60
                        });
                    }
                }
            }
        } catch (err: unknown) {
            logger.debug('[INSTAGRAM_CONSUMER] Circuit breaker open failed (ignored)', {
                deviceId,
                error: err instanceof Error ? err.message : String(err)
            });
        }

        // InfluxDB integration is not present on `main`. Audit trail is stored in MongoDB
        // (`instagram_fetch_audit`) and per-device change detection is stored in Redis.

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
