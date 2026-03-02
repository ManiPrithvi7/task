import { Kafka, Producer, logLevel, SASLOptions } from 'kafkajs';
import { logger } from '../utils/logger';
import { KafkaConfig } from '../config';

export class KafkaService {
  private kafka: Kafka;
  private producer: Producer;
  private connected = false;
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
      allowAutoTopicCreation: false,
      idempotent: true,
      maxInFlightRequests: 5
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

    await this.producer.send({
      topic: targetTopic,
      messages: [
        {
          key,
          value: payload
        }
      ]
    });
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    await this.producer.disconnect();
    this.connected = false;
    logger.info('Kafka producer disconnected');
  }
}

