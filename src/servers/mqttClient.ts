import mqtt, { MqttClient, IClientOptions, IPublishPacket } from 'mqtt';
import * as dns from 'dns';
import * as tls from 'tls';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger';
import { caForBrokerTls } from '../utils/tlsBrokerCa';

export interface MqttConfig {
  broker: string;
  port: number;
  clientId: string;
  authX509Only?: boolean;
  username?: string;
  password?: string;
  topicPrefix: string;
  topicRoot: string;
  /** mqtt.js reconnect interval in ms (default 2000). */
  reconnectPeriod?: number;
  /**
   * Custom reconnect cap before calling client.end(true).
   * 0 = infinite retries (cap bypassed entirely; mqtt.js keeps reconnecting).
   */
  maxReconnectAttempts?: number;
  /** Pre-resolve broker hostname before connect (adds startup latency). */
  dnsPreflightEnabled?: boolean;
  tls?: {
    enabled?: boolean;
    /** Filled from env → DATA_DIR/.mqtt-tls/ at config load (see config/index.ts). */
    caPem?: string;
    clientCertPem?: string;
    clientKeyPem?: string;
    rejectUnauthorized?: boolean;
    servername?: string;
  };
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
  private maxReconnectAttempts: number;
  private pendingAcks: Map<number, PendingAck> = new Map();
  private recentPublishes: Map<string, { timestamp: number; metadata: PublishMetadata }> = new Map();
  private readonly ECHO_WINDOW_MS = 2000;
  
  private onDeviceInactive?: (deviceId: string) => void;
  private onDeviceActive?: (deviceId: string) => void;

  constructor(config: MqttConfig) {
    super();
    this.config = config;
    // 0 = infinite — custom reconnect cap in `reconnect` handler is bypassed when 0.
    this.maxReconnectAttempts = config.maxReconnectAttempts ?? 0;
  }

  setDeviceCallbacks(
    onInactive: (deviceId: string) => void,
    onActive: (deviceId: string) => void
  ): void {
    this.onDeviceInactive = onInactive;
    this.onDeviceActive = onActive;
  }

  async connect(): Promise<void> {
    if (this.config.dnsPreflightEnabled) {
      await this.resolveBrokerDns();
    }

    return new Promise((resolve, reject) => {
      const options: IClientOptions = {
        clientId: this.config.clientId,
        clean: true,
        connectTimeout: 30000,
        reconnectPeriod: this.config.reconnectPeriod ?? 2000,
        keepalive: 45,
        protocolVersion: 5
      };

      const x509Only = this.config.authX509Only === true;
      if (!x509Only) {
        if (this.config.username) options.username = this.config.username;
        if (this.config.password) options.password = this.config.password;
      }

      const tlsCfg = this.config.tls;
      if (!tlsCfg?.enabled) {
        reject(new Error('mTLS-only MQTT: TLS is required (no plaintext fallback)'));
        return;
      }

      // Enforce mTLS-only connection (no fallback to mqtt://)
      let brokerUrl = `mqtts://${this.config.broker}:${this.config.port}`;
      try {
        if (!tlsCfg.caPem?.includes('-----BEGIN')) {
          throw new Error('mTLS-only MQTT: missing broker CA PEM');
        }
        if (!tlsCfg.clientCertPem?.includes('-----BEGIN')) {
          throw new Error('mTLS-only MQTT: missing client certificate PEM');
        }
        if (!tlsCfg.clientKeyPem?.includes('-----BEGIN')) {
          throw new Error('mTLS-only MQTT: missing client private key PEM');
        }

        options.ca = caForBrokerTls(tlsCfg.caPem);
        options.cert = tlsCfg.clientCertPem;
        options.key = tlsCfg.clientKeyPem;

        options.rejectUnauthorized = tlsCfg.rejectUnauthorized !== false;
        if (tlsCfg.servername) {
          (options as any).servername = tlsCfg.servername;
        }
        // mqtt.js overwrites servername with the URL hostname in connect/tls.js (buildStream),
        // so TLS hostname verification uses MQTT_BROKER even when MQTT_TLS_SERVERNAME is set.
        // Pin verification to the cert identity (e.g. nanomq-broker) when they differ (Railway TCP proxy).
        const expectedServerName = tlsCfg.servername?.trim();
        if (expectedServerName && expectedServerName !== this.config.broker) {
          (options as any).checkServerIdentity = (_hostname: string, cert: tls.PeerCertificate) =>
            tls.checkServerIdentity(expectedServerName, cert);
        }
      } catch (err: any) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      logger.info('Connecting to MQTT broker...', {
        broker: this.config.broker,
        port: this.config.port,
        clientId: this.config.clientId,
        mqttAuth: x509Only ? 'X.509 only (no CONNECT username/password)' : 'username/password if configured'
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
        // maxReconnectAttempts === 0 means infinite — never call client.end(true).
        if (this.maxReconnectAttempts > 0 && this.reconnectAttempts > this.maxReconnectAttempts) {
          logger.warn('Max reconnect attempts reached - stopping reconnect', {
            attempt: this.reconnectAttempts,
            maxAttempts: this.maxReconnectAttempts
          });
          this.client?.end(true);
        } else {
          logger.debug('Attempting to reconnect to MQTT broker...', {
            attempt: this.reconnectAttempts,
            maxAttempts: this.maxReconnectAttempts === 0 ? 'infinite' : this.maxReconnectAttempts
          });
        }
      });

      this.client.on('close', () => {
        this.clearPendingAcks('close');
        logger.debug('MQTT connection closed - will reconnect automatically');
      });

      this.client.on('offline', () => {
        this.clearPendingAcks('offline');
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
      if (!this.client || !this.isConnected()) {
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
      this.clearPendingAcks('disconnect');
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

  private clearPendingAcks(reason: string): void {
    for (const [messageId, pending] of this.pendingAcks.entries()) {
      clearTimeout(pending.timeout);
      logger.debug('Cleared pending PUBACK timer', { messageId, reason });
    }
    this.pendingAcks.clear();
  }

  private async resolveBrokerDns(maxAttempts = 5): Promise<void> {
    const hostname = this.config.broker;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await dns.promises.lookup(hostname);
        logger.debug('MQTT broker DNS preflight succeeded', { hostname, attempt });
        return;
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === 'EAI_AGAIN' && attempt < maxAttempts) {
          const delayMs = 1000 * Math.pow(2, attempt);
          logger.warn('MQTT broker DNS lookup failed, retrying', {
            hostname,
            attempt,
            maxAttempts,
            delayMs
          });
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        throw err;
      }
    }
  }

  private trackQoS1Message(packet: any): void {
    const deviceId = this.extractDeviceIdFromTopic(packet.topic);
    if (!deviceId) return;

    const messageId = packet.messageId;

    const timeout = setTimeout(() => {
      if (!this.isConnected()) {
        logger.debug('QoS1 PUBACK pending but MQTT offline — skip inactive mark', {
          deviceId,
          messageId,
          topic: packet.topic
        });
        this.pendingAcks.delete(messageId);
        return;
      }

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

