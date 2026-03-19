import { Kafka, Producer, logLevel, SASLOptions, Partitioners } from 'kafkajs';
import { logger } from '../utils/logger';
import { connectWithRetry } from '../utils/kafkaRetry';
import { KafkaConfig } from '../config';
import { FETCH_REQUESTS_TOPIC, FETCH_RESULTS_TOPIC, FetchRequest } from './instagramFetchConsumer';

const KAFKA_CONNECTION_TIMEOUT_MS = 10000;

/** Topics required for Instagram fetch flow and cross-domain events. Created at startup if missing. */
const REQUIRED_TOPICS = [
  { topic: FETCH_REQUESTS_TOPIC, numPartitions: 3, replicationFactor: 1 },
  { topic: FETCH_RESULTS_TOPIC, numPartitions: 3, replicationFactor: 1 },
  { topic: 'instagram-errors', numPartitions: 2, replicationFactor: 1 },
  { topic: 'social-webhook-events', numPartitions: 3, replicationFactor: 1 }
] as const;

export class KafkaService {
  private kafka: Kafka;
  private producer: Producer;
  public connected = false;
  private config: KafkaConfig;

  constructor(config: KafkaConfig) {
    this.config = config;

    this.kafka = new Kafka({
      clientId: config.clientId,
      brokers: config.brokers,
      ssl: config.ssl || undefined,
      sasl: config.sasl as SASLOptions | undefined,
      logLevel: logLevel.INFO,
      connectionTimeout: KAFKA_CONNECTION_TIMEOUT_MS,
      requestTimeout: KAFKA_CONNECTION_TIMEOUT_MS
    });

    this.producer = this.kafka.producer({
      allowAutoTopicCreation: true,
      idempotent: true,
      maxInFlightRequests: 5,
      createPartitioner: Partitioners.LegacyPartitioner
    });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await connectWithRetry(() => this.producer.connect(), 'Kafka producer');
    this.connected = true;
    logger.info('✅ Kafka producer connected', {
      brokers: this.config.brokers,
      clientId: this.config.clientId
    });
  }

  /**
   * Ensure required Kafka topics exist before consumers start.
   * Prevents "This server does not host this topic-partition" when subscribing to new topics.
   */
  async ensureTopics(): Promise<void> {
    const admin = this.kafka.admin();
    try {
      await admin.connect();
      const existing = await admin.listTopics();
      const toCreate = REQUIRED_TOPICS.filter(t => !existing.includes(t.topic));
      if (toCreate.length > 0) {
        await admin.createTopics({
          topics: toCreate.map(({ topic, numPartitions, replicationFactor }) => ({
            topic,
            numPartitions,
            replicationFactor
          })),
          waitForLeaders: true,
          timeout: 10000
        });
        logger.info('Kafka topics created', {
          topics: toCreate.map(t => t.topic)
        });
      }
      // Brief delay so broker metadata is updated before consumers subscribe
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('Kafka ensureTopics failed (continuing anyway)', { error: msg });
    } finally {
      await admin.disconnect();
    }
  }

  async produce(topic: string | undefined, value: unknown, key?: string): Promise<void> {
    if (!this.connected) {
      await this.connect();
    }

    const targetTopic = topic && topic.trim().length > 0 ? topic : this.config.defaultTopic;
    const payload = typeof value === 'string' ? value : JSON.stringify(value);

    logger.info('📤 [KAFKA:PUBLISH] Sending event', {
      topic: targetTopic,
      key: key || '(none)',
      payloadSize: `${payload.length} bytes`
    });

    await this.producer.send({
      topic: targetTopic,
      messages: [{ key, value: payload }]
    });

    logger.info('✅ [KAFKA:PUBLISH] Event published successfully', {
      topic: targetTopic,
      key: key || '(none)',
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Publish an Instagram fetch request for a device.
   * Uses deviceId as the partition key for ordered, per-device processing.
   */
  async publishInstagramFetchRequest(
    deviceId: string,
    trigger: FetchRequest['trigger'],
    userId?: string
  ): Promise<void> {
    if (!this.connected) await this.connect();

    const request: FetchRequest = {
      deviceId,
      trigger,
      priority: trigger === 'new_connection' ? 'high' : 'normal',
      requested_at: new Date().toISOString(),
      force_refresh: false,
      ...(userId ? { userId } : {})
    };

    await this.producer.send({
      topic: FETCH_REQUESTS_TOPIC,
      messages: [{ key: deviceId, value: JSON.stringify(request) }]
    });

    logger.info('📤 [KAFKA] Instagram fetch request published', { deviceId, trigger });
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    await this.producer.disconnect();
    this.connected = false;
    logger.info('Kafka producer disconnected');
  }
}
