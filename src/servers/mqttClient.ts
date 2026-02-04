import mqtt, { MqttClient, IClientOptions, IPublishPacket } from 'mqtt';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger';

export interface MqttConfig {
  broker: string;
  port: number;
  clientId: string;
  username?: string;
  password?: string;
  topicPrefix: string;
  topicRoot: string;
}

export interface MqttMessage {
  topic: string;
  payload: string;
  qos?: 0 | 1 | 2;
  retain?: boolean;
}

export interface PublishMetadata {
  direction?: 'server_to_client' | 'client_to_server' | 'broker_to_server';
  source?: string;
  deviceId?: string;
  timestamp?: string;
  initiator?: string;
}

interface PendingAck {
  topic: string;
  deviceId: string;
  timestamp: number;
  timeout: NodeJS.Timeout;
}

type MessageHandler = (topic: string, payload: Buffer, packet?: any) => void;

export class MqttClientManager extends EventEmitter {
  private client: MqttClient | null = null;
  private config: MqttConfig;
  private messageHandlers: Map<string, MessageHandler> = new Map();
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private pendingAcks: Map<number, PendingAck> = new Map();
  private recentPublishes: Map<string, { timestamp: number; metadata: PublishMetadata }> = new Map();
  private readonly ECHO_WINDOW_MS = 2000;
  
  private onDeviceInactive?: (deviceId: string) => void;
  private onDeviceActive?: (deviceId: string) => void;

  constructor(config: MqttConfig) {
    super();
    this.config = config;
  }

  setDeviceCallbacks(
    onInactive: (deviceId: string) => void,
    onActive: (deviceId: string) => void
  ): void {
    this.onDeviceInactive = onInactive;
    this.onDeviceActive = onActive;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const options: IClientOptions = {
        clientId: this.config.clientId,
        clean: true,
        connectTimeout: 30000,
        reconnectPeriod: 30000,
        keepalive: 120,
        protocolVersion: 5
      };

      if (this.config.username) {
        options.username = this.config.username;
      }
      if (this.config.password) {
        options.password = this.config.password;
      }

      const brokerUrl = `mqtt://${this.config.broker}:${this.config.port}`;
      logger.info('Connecting to MQTT broker...', {
        broker: this.config.broker,
        port: this.config.port,
        clientId: this.config.clientId
      });

      this.client = mqtt.connect(brokerUrl, options);

      this.client.on('connect', () => {
        this.reconnectAttempts = 0;
        logger.info('Connected to MQTT broker', {
          broker: this.config.broker,
          clientId: this.config.clientId
        });
        resolve();
      });

      this.client.on('error', (error) => {
        logger.error('MQTT client error', { error: error.message });
        if (this.reconnectAttempts === 0) {
          reject(error);
        }
      });

      this.client.on('reconnect', () => {
        this.reconnectAttempts++;
        if (this.reconnectAttempts > this.maxReconnectAttempts) {
          logger.error('Max reconnect attempts reached - stopping reconnect');
          this.client?.end(true);
        } else {
          logger.debug('Attempting to reconnect to MQTT broker...', {
            attempt: this.reconnectAttempts,
            maxAttempts: this.maxReconnectAttempts
          });
        }
      });

      this.client.on('close', () => {
        logger.debug('MQTT connection closed - will reconnect automatically');
      });

      this.client.on('offline', () => {
        logger.debug('MQTT client is offline - reconnecting...');
      });

      this.client.on('packetsend', (packet: any) => {
        if (packet.cmd === 'publish' && packet.qos === 1 && packet.messageId) {
          logger.info('📤 QoS 1 message sent', {
            messageId: packet.messageId,
            topic: packet.topic,
            qos: packet.qos
          });
          this.trackQoS1Message(packet);
        }
      });

      this.client.on('packetreceive', (packet: any) => {
        if (packet.cmd === 'puback' && packet.messageId) {
          logger.info('✅ PUBACK received', { messageId: packet.messageId });
          this.handlePubAck(packet.messageId);
        }
      });

      this.client.on('message', (topic, payload, packet) => {
        logger.debug('Message received', {
          topic,
          size: payload.length,
          retain: packet?.retain || false
        });

        const messageKey = `${topic}:${payload.toString().substring(0, 100)}`;
        const recentPublish = this.recentPublishes.get(messageKey);
        const now = Date.now();

        for (const [key, entry] of this.recentPublishes.entries()) {
          if (now - entry.timestamp > this.ECHO_WINDOW_MS) {
            this.recentPublishes.delete(key);
          }
        }

        let direction: string;
        let source: string;

        if (recentPublish && (now - recentPublish.timestamp) < this.ECHO_WINDOW_MS) {
          logger.debug('Skipping echo message', { topic, age: `${now - recentPublish.timestamp}ms` });
          this.recentPublishes.delete(messageKey);
          
          for (const [pattern, handler] of this.messageHandlers) {
            if (this.topicMatches(topic, pattern)) {
              try {
                handler(topic, payload, packet);
              } catch (error: any) {
                logger.error('Error in message handler', {
                  topic,
                  pattern,
                  error: error.message
                });
              }
            }
          }
          return;
        }

        if (topic.endsWith('/lwt')) {
          direction = 'broker_to_server';
          source = 'broker';
          logger.info('📨 Broker-generated LWT message detected', { topic });
        } else {
          direction = 'client_to_server';
          source = 'device';
        }

        const wsMessage = {
          type: 'message',
          topic,
          payload: payload.toString(),
          qos: packet?.qos || 0,
          retain: packet?.retain || false,
          direction,
          source,
          deviceId: this.extractDeviceIdFromTopic(topic) || undefined,
          timestamp: new Date().toISOString(),
          byteSize: payload.length
        };

        this.emit('messageReceived', wsMessage);

        for (const [pattern, handler] of this.messageHandlers) {
          if (this.topicMatches(topic, pattern)) {
            try {
              handler(topic, payload, packet);
            } catch (error: any) {
              logger.error('Error in message handler', {
                topic,
                pattern,
                error: error.message
              });
            }
          }
        }
      });
    });
  }

  async publish(message: MqttMessage, metadata?: PublishMetadata): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.client) {
        reject(new Error('MQTT client not connected'));
        return;
      }

      const fullTopic = this.config.topicPrefix
        ? `${this.config.topicPrefix}/${message.topic}`
        : message.topic;

      const publishTime = Date.now();
      const payloadString = message.payload;
      const byteSize = Buffer.byteLength(payloadString);

      this.client.publish(
        fullTopic,
        message.payload,
        { qos: message.qos, retain: message.retain },
        (error) => {
          if (error) {
            logger.error('Failed to publish message', {
              topic: fullTopic,
              error: error.message
            });
            reject(error);
          } else {
            const deliveryTime = Date.now() - publishTime;
            logger.debug('Message published', {
              topic: fullTopic,
              qos: message.qos,
              deliveryTime: `${deliveryTime}ms`
            });

            const messageKey = `${fullTopic}:${payloadString.substring(0, 100)}`;
            this.recentPublishes.set(messageKey, {
              timestamp: Date.now(),
              metadata: metadata || {}
            });

            const wsMessage = {
              type: 'message',
              topic: fullTopic,
              payload: payloadString,
              qos: message.qos,
              retain: message.retain,
              direction: metadata?.direction || 'server_to_client',
              source: metadata?.source || 'backend',
              deviceId: metadata?.deviceId || this.extractDeviceIdFromTopic(fullTopic) || undefined,
              timestamp: new Date().toISOString(),
              byteSize,
              deliveryTime
            };

            this.emit('messagePublished', wsMessage);
            resolve();
          }
        }
      );
    });
  }

  async subscribe(topic: string, handler: MessageHandler): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.client) {
        reject(new Error('MQTT client not connected'));
        return;
      }

      const fullTopic = this.config.topicPrefix
        ? `${this.config.topicPrefix}/${topic}`
        : topic;

      this.client.subscribe(fullTopic, { qos: 1 }, (error) => {
        if (error) {
          logger.error('Failed to subscribe', {
            topic: fullTopic,
            error: error.message
          });
          reject(error);
        } else {
          this.messageHandlers.set(fullTopic, handler);
          logger.info('Subscribed to topic', { topic: fullTopic });
          resolve();
        }
      });
    });
  }

  async unsubscribe(topic: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.client) {
        reject(new Error('MQTT client not connected'));
        return;
      }

      const fullTopic = this.config.topicPrefix
        ? `${this.config.topicPrefix}/${topic}`
        : topic;

      this.client.unsubscribe(fullTopic, (error) => {
        if (error) {
          logger.error('Failed to unsubscribe', {
            topic: fullTopic,
            error: error.message
          });
          reject(error);
        } else {
          this.messageHandlers.delete(fullTopic);
          logger.info('Unsubscribed from topic', { topic: fullTopic });
          resolve();
        }
      });
    });
  }

  private topicMatches(topic: string, pattern: string): boolean {
    const regexPattern = pattern
      .replace(/\+/g, '[^/]+')
      .replace(/#/g, '.*');
    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(topic);
  }

  isConnected(): boolean {
    return this.client?.connected || false;
  }

  getTopicRoot(): string {
    return this.config.topicRoot;
  }

  async disconnect(): Promise<void> {
    return new Promise((resolve) => {
      for (const pending of this.pendingAcks.values()) {
        clearTimeout(pending.timeout);
      }
      this.pendingAcks.clear();
      this.recentPublishes.clear();

      if (this.client) {
        this.client.end(false, {}, () => {
          logger.info('MQTT client disconnected');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  private trackQoS1Message(packet: any): void {
    const deviceId = this.extractDeviceIdFromTopic(packet.topic);
    if (!deviceId) return;

    const messageId = packet.messageId;

    const timeout = setTimeout(() => {
      logger.warn('QoS 1 PUBACK timeout - marking device inactive', {
        deviceId,
        topic: packet.topic,
        messageId,
        timeout: '30s'
      });

      if (this.onDeviceInactive) {
        this.onDeviceInactive(deviceId);
      }

      this.pendingAcks.delete(messageId);
    }, 30000);

    this.pendingAcks.set(messageId, {
      topic: packet.topic,
      deviceId,
      timestamp: Date.now(),
      timeout
    });

    logger.info('⏱️ Tracking QoS 1 message (30s timeout)', {
      deviceId,
      messageId,
      topic: packet.topic,
      pendingCount: this.pendingAcks.size
    });
  }

  private handlePubAck(messageId: number): void {
    const pending = this.pendingAcks.get(messageId);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pendingAcks.delete(messageId);

    const deliveryTime = Date.now() - pending.timestamp;
    logger.info('✅ QoS 1 PUBACK confirmed', {
      deviceId: pending.deviceId,
      messageId,
      deliveryTime: `${deliveryTime}ms`,
      pendingCount: this.pendingAcks.size
    });

    if (this.onDeviceActive) {
      this.onDeviceActive(pending.deviceId);
    }
  }

  private extractDeviceIdFromTopic(topic: string): string | null {
    const root = this.config.topicRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = topic.match(new RegExp(`^${root}/([^/]+)/`));
    return match ? match[1] : null;
  }

  getPendingAckCount(): number {
    return this.pendingAcks.size;
  }
}

