import { Kafka, Producer, Consumer, logLevel, SASLOptions, Partitioners, EachMessagePayload } from 'kafkajs';
import { logger } from '../utils/logger';
import { KafkaConfig } from '../config';

export class KafkaService {
  private kafka: Kafka;
  private producer: Producer;
  private consumer: Consumer;
  public connected = false;
  private consumerConnected = false;
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

    this.consumer = this.kafka.consumer({
      groupId: `${config.clientId}-group`
    });
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    // Connect Producer
    await this.producer.connect();
    this.connected = true;
    logger.info('✅ Kafka producer connected', {
      brokers: this.config.brokers,
      clientId: this.config.clientId
    });

    // Connect Consumer
    try {
      await this.consumer.connect();
      this.consumerConnected = true;
      logger.info('✅ Kafka consumer connected', {
        groupId: `${this.config.clientId}-group`
      });
    } catch (error: any) {
      logger.error('❌ Failed to connect Kafka consumer', { error: error.message });
      // We don't throw here to allow the producer to function even if consumer fails
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
      messages: [
        {
          key,
          value: payload
        }
      ]
    });

    logger.info('✅ [KAFKA:PUBLISH] Event published successfully', {
      topic: targetTopic,
      key: key || '(none)',
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Subscribe to topics and start consuming messages
   */
  async consume(topics: string[], onMessage: (topic: string, partition: number, message: any) => Promise<void>): Promise<void> {
    if (!this.consumerConnected) {
      await this.connect();
    }

    if (!this.consumerConnected) {
      logger.error('Cannot subscribe: Kafka consumer not connected');
      return;
    }

    await this.consumer.subscribe({ topics, fromBeginning: false });

    await this.consumer.run({
      eachMessage: async ({ topic, partition, message }: EachMessagePayload) => {
        try {
          const payload = message.value?.toString();
          const parsedValue = payload ? JSON.parse(payload) : null;

          logger.info('📥 [KAFKA:CONSUMER] Message received', {
            topic,
            partition,
            offset: message.offset,
            key: message.key?.toString() || '(none)'
          });

          await onMessage(topic, partition, parsedValue);
        } catch (error: any) {
          logger.error('Error processing Kafka consumer message', {
            topic,
            error: error.message,
            payload: message.value?.toString()
          });
        }
      }
    });

    logger.info('📢 Kafka consumer subscribed to topics', { topics });
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      await this.producer.disconnect();
      this.connected = false;
      logger.info('Kafka producer disconnected');
    }
    if (this.consumerConnected) {
      await this.consumer.disconnect();
      this.consumerConnected = false;
      logger.info('Kafka consumer disconnected');
    }
  }
}

