/**
 * Instagram Result Consumer
 *
 * Kafka Consumer Group: "instagram-result-consumers"
 * Topic consumed: instagram-fetch-results
 *
 * For each result:
 *   1. Checks if device is still active in Redis
 *   2. Formats the MQTT payload for the device display
 *   3. Publishes to proof.mqtt/{deviceId}/instagram (QoS 1)
 *   4. If device offline → queues in Redis pending list
 */

import {
    Kafka, Consumer, logLevel,
    SASLOptions, EachMessagePayload
} from 'kafkajs';
import { logger } from '../utils/logger';
import { KafkaConfig } from '../config';
import { MqttClientManager } from '../servers/mqttClient';
import { getActiveDeviceCache } from './deviceService';
import { getRedisService } from './redisService';
import { FETCH_RESULTS_TOPIC, FetchResult } from './instagramFetchConsumer';

const RESULT_CONSUMER_GROUP = 'instagram-result-consumers';
const PENDING_KEY_PREFIX = 'instagram:pending:';

function calculateProgress(followers: number, target: number): number {
    return Math.min(100, Math.round((followers / target) * 100));
}

function getNextMilestone(followers: number): number {
    const milestones = [100, 500, 1000, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000];
    return milestones.find(m => m > followers) ?? Math.ceil(followers / 1000) * 1000 + 1000;
}

function generateMessage(followers: number): string {
    const target = getNextMilestone(followers);
    const remaining = target - followers;
    if (remaining <= 50) return `🎉 Almost at ${target >= 1000 ? Math.round(target / 1000) + 'k' : target}!`;
    if (target >= 1000) return `${remaining} away from ${Math.round(target / 1000)}k followers!`;
    return `${remaining} more to reach ${target} followers!`;
}

function formatMqttPayload(result: FetchResult, topicRoot: string): { topic: string; payload: string } {
    const { deviceId, data } = result;
    const followers = data?.followers_count ?? 0;
    const target = getNextMilestone(followers);
    const progress = calculateProgress(followers, target);
    const isCelebration = progress >= 100;

    const inner = isCelebration
        ? {
            followers_count: followers,
            celebration_type: 'milestone',
            duration: 20,
            target,
            progress: 100,
            color_palette: 'instagram',
            message: '🎉 You made it!',
            animation: 'pulse_grow',
            sound: 'celebration.wav',
            url: 'https://instagram.com'
        }
        : {
            followers_count: followers,
            duration: 15,
            target,
            progress,
            color_palette: 'instagram',
            message: generateMessage(followers),
            animation: 'pulse_grow',
            url: 'https://instagram.com'
        };

    const payload = {
        version: '1.1',
        id: `msg_inst_${Date.now()}`,
        type: 'screen_update',
        screen: 'instagram',
        muted: false,
        timestamp: result.fetched_at,
        payload: inner
    };

    return {
        topic: `${topicRoot}/${deviceId}/instagram`,
        payload: JSON.stringify(payload)
    };
}

export class InstagramResultConsumer {
    private kafka: Kafka;
    private consumer: Consumer;
    private mqttClient: MqttClientManager;
    private topicRoot: string;
    private running = false;

    constructor(config: KafkaConfig, mqttClient: MqttClientManager) {
        this.mqttClient = mqttClient;
        this.topicRoot = mqttClient.getTopicRoot();

        this.kafka = new Kafka({
            clientId: `${config.clientId}-instagram-result`,
            brokers: config.brokers,
            ssl: config.ssl || undefined,
            sasl: config.sasl as SASLOptions | undefined,
            logLevel: logLevel.WARN
        });

        this.consumer = this.kafka.consumer({ groupId: RESULT_CONSUMER_GROUP });
    }

    async start(): Promise<void> {
        if (this.running) return;

        await this.consumer.connect();
        await this.consumer.subscribe({ topics: [FETCH_RESULTS_TOPIC], fromBeginning: false });

        this.running = true;
        logger.info('📬 [INSTAGRAM_RESULT] Consumer started', {
            group: RESULT_CONSUMER_GROUP,
            topic: FETCH_RESULTS_TOPIC
        });

        await this.consumer.run({
            eachMessage: async ({ message }: EachMessagePayload) => {
                const raw = message.value?.toString();
                if (!raw) return;

                let result: FetchResult;
                try {
                    result = JSON.parse(raw);
                } catch {
                    logger.warn('[INSTAGRAM_RESULT] Failed to parse message', { raw: raw.slice(0, 200) });
                    return;
                }

                await this.handleResult(result);
            }
        });
    }

    private async handleResult(result: FetchResult): Promise<void> {
        const { deviceId, success } = result;

        if (!success || !result.data) {
            logger.warn('[INSTAGRAM_RESULT] Skipping failed result', { deviceId, error: result.error });
            return;
        }

        // Check if device is currently active in Redis
        const cache = getActiveDeviceCache();
        const activeDevices = await cache.getAllActive();
        const isActive = activeDevices.some(d => d.deviceId === deviceId);

        const { topic, payload } = formatMqttPayload(result, this.topicRoot);

        if (isActive) {
            try {
                await this.mqttClient.publish({ topic, payload, qos: 1, retain: false });
                logger.info('📡 [INSTAGRAM_RESULT] Published to device', {
                    deviceId,
                    topic,
                    followers: result.data.followers_count
                });
            } catch (err: unknown) {
                logger.error('[INSTAGRAM_RESULT] MQTT publish failed', {
                    deviceId,
                    error: err instanceof Error ? err.message : String(err)
                });
            }
        } else {
            // Device is offline — queue for delivery on reconnect
            const redis = getRedisService();
            if (redis?.isRedisConnected()) {
                const client = redis.getClient();
                const key = `${PENDING_KEY_PREFIX}${deviceId}`;
                await client.lPush(key, payload);
                await client.expire(key, 86400); // 24h TTL
                logger.info('[INSTAGRAM_RESULT] Device offline — queued for later delivery', { deviceId, key });
            } else {
                logger.warn('[INSTAGRAM_RESULT] Device offline and Redis unavailable — result lost', { deviceId });
            }
        }
    }

    /**
     * Flush any pending Instagram messages for a device that just came online.
     * Called by StatsPublisher when a device registers / reconnects.
     */
    async flushPendingForDevice(deviceId: string): Promise<void> {
        const redis = getRedisService();
        if (!redis?.isRedisConnected()) return;

        const client = redis.getClient();
        const key = `${PENDING_KEY_PREFIX}${deviceId}`;
        const count = await client.lLen(key);
        if (count === 0) return;

        const topicRoot = this.topicRoot;
        const topic = `${topicRoot}/${deviceId}/instagram`;

        // Pop and publish all pending messages (most recent first via lPop)
        for (let i = 0; i < count; i++) {
            const payload = await client.lPop(key);
            if (!payload) break;
            try {
                await this.mqttClient.publish({ topic, payload, qos: 1, retain: false });
                logger.info('[INSTAGRAM_RESULT] Flushed pending message to device', { deviceId });
            } catch (err: unknown) {
                logger.error('[INSTAGRAM_RESULT] Failed to flush pending message', {
                    deviceId,
                    error: err instanceof Error ? err.message : String(err)
                });
                break;
            }
        }
    }

    async stop(): Promise<void> {
        this.running = false;
        await this.consumer.disconnect();
        logger.info('[INSTAGRAM_RESULT] Consumer stopped');
    }
}

let _instance: InstagramResultConsumer | null = null;

export function createInstagramResultConsumer(
    config: KafkaConfig,
    mqttClient: MqttClientManager
): InstagramResultConsumer {
    _instance = new InstagramResultConsumer(config, mqttClient);
    return _instance;
}

export function getInstagramResultConsumer(): InstagramResultConsumer | null {
    return _instance;
}
