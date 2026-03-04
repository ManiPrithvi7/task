import { Kafka, Producer, logLevel, SASLOptions, Partitioners } from 'kafkajs';
import { logger } from '../utils/logger';
import { KafkaConfig } from '../config';
import { FETCH_REQUESTS_TOPIC, FetchRequest } from './instagramFetchConsumer';

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
      logLevel: logLevel.INFO
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
    await this.producer.connect();
    this.connected = true;
    logger.info('✅ Kafka producer connected', {
      brokers: this.config.brokers,
      clientId: this.config.clientId
    });
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
