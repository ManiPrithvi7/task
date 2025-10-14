import mqtt, { MqttClient, IClientOptions } from 'mqtt';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger';
import { AppConfig } from '../config';
import { MqttMessage, MessageMetadata, WebSocketMessage } from '../types';

export class MqttClientManager extends EventEmitter {
  private client: MqttClient | null = null;
  private config: AppConfig['mqtt'];
  private messageHandlers: Map<string, (topic: string, payload: Buffer, packet?: any) => void> = new Map();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  
  // QoS 1 tracking for device liveness
  private pendingAcks: Map<number, {
    topic: string;
    deviceId: string;
    timestamp: number;
    timeout: NodeJS.Timeout;
  }> = new Map();
  
  // Track recently published messages to avoid duplicates (echo from broker)
  private recentPublishes: Map<string, { timestamp: number; metadata: Partial<MessageMetadata> }> = new Map();
  private readonly ECHO_WINDOW_MS = 2000; // 2 second window to detect echoes
  
  // Device connectivity callbacks
  private onDeviceInactive?: (deviceId: string) => void;
  private onDeviceActive?: (deviceId: string) => void;

  constructor(config: AppConfig['mqtt']) {
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
        reconnectPeriod: 30000,  // Reduced from 5s to 30s - less aggressive
        keepalive: 120,  // Increased from 60s to 120s - more stable
        protocolVersion: 5  // Use MQTT 5 for better connection stability
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
          // Use debug level to reduce log spam
          logger.debug('Attempting to reconnect to MQTT broker...', {
            attempt: this.reconnectAttempts,
            maxAttempts: this.maxReconnectAttempts
          });
        }
      });

      this.client.on('close', () => {
        // Use debug level - only show errors, not normal reconnects
        logger.debug('MQTT connection closed - will reconnect automatically');
      });

      this.client.on('offline', () => {
        // Use debug level to reduce log spam
        logger.debug('MQTT client is offline - reconnecting...');
      });

      // Track PUBACK for QoS 1 messages using packetreceive event
      (this.client as any).on('packetsend', (packet: any) => {
        if (packet.cmd === 'publish' && packet.qos === 1 && packet.messageId) {
          logger.info('📤 QoS 1 message sent', {
            messageId: packet.messageId,
            topic: packet.topic,
            qos: packet.qos
          });
          this.trackQoS1Message(packet);
        }
      });

      (this.client as any).on('packetreceive', (packet: any) => {
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

        // Check if this is an echo of our own published message
        const messageKey = `${topic}:${payload.toString().substring(0, 100)}`;
        const recentPublish = this.recentPublishes.get(messageKey);
        const now = Date.now();
        
        // Clean up old entries
        for (const [key, entry] of this.recentPublishes.entries()) {
          if (now - entry.timestamp > this.ECHO_WINDOW_MS) {
            this.recentPublishes.delete(key);
          }
        }

        // Determine message direction and source
        let direction: WebSocketMessage['direction'];
        let source: WebSocketMessage['source'];
        
        if (recentPublish && (now - recentPublish.timestamp) < this.ECHO_WINDOW_MS) {
          // This is an echo of our own message - skip it to avoid duplicates
          logger.debug('Skipping echo message', { topic, age: `${now - recentPublish.timestamp}ms` });
          this.recentPublishes.delete(messageKey);
          
          // Still call handlers for processing but don't broadcast to WebSocket
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
        
        // ✅ FIX: Check if this is a broker-generated LWT message
        if (topic.endsWith('/lwt')) {
          // Last Will and Testament messages are broker-generated
          direction = 'broker_to_server';
          source = 'broker';
          logger.info('📨 Broker-generated LWT message detected', { topic });
        } else {
          // Regular message from a device/client
          direction = 'client_to_server';
          source = 'device';
        }
        
        // Emit message event for WebSocket broadcast
        const wsMessage: WebSocketMessage = {
          type: 'message',
          topic,
          payload: payload.toString(),
          qos: packet?.qos as 0 | 1 | 2 || 0,
          retain: packet?.retain || false,
          direction,
          source,
          deviceId: this.extractDeviceIdFromTopic(topic) || undefined,
          timestamp: new Date().toISOString(),
          byteSize: payload.length
        };

        this.emit('messageReceived', wsMessage);
        
        // Call registered handlers with packet info
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

  async publish(message: MqttMessage, metadata?: Partial<MessageMetadata>): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.client) {
        reject(new Error('MQTT client not connected'));
        return;
      }

      const fullTopic = this.config.topicPrefix 
        ? `${this.config.topicPrefix}/${message.topic}`
        : message.topic;

      const publishTime = Date.now();
      const payloadString = typeof message.payload === 'string' ? message.payload : message.payload.toString();
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

            // Track this message to identify echoes from broker
            const messageKey = `${fullTopic}:${payloadString.substring(0, 100)}`;
            this.recentPublishes.set(messageKey, {
              timestamp: Date.now(),
              metadata: metadata || {}
            });

            // Emit message event with metadata for WebSocket broadcast
            const wsMessage: WebSocketMessage = {
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

  async subscribe(topic: string, handler: (topic: string, payload: Buffer, packet?: any) => void): Promise<void> {
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
    // Convert MQTT wildcards to regex
    const regexPattern = pattern
      .replace(/\+/g, '[^/]+')
      .replace(/#/g, '.*');
    
    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(topic);
  }

  isConnected(): boolean {
    return this.client?.connected || false;
  }

  async disconnect(): Promise<void> {
    return new Promise((resolve) => {
      // Clear all pending ACK timeouts
      for (const pending of this.pendingAcks.values()) {
        clearTimeout(pending.timeout);
      }
      this.pendingAcks.clear();
      
      // Clear recent publishes tracking
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
    
    // Set timeout for PUBACK (30 seconds)
    const timeout = setTimeout(() => {
      logger.warn('QoS 1 PUBACK timeout - marking device inactive', {
        deviceId,
        topic: packet.topic,
        messageId,
        timeout: '30s'
      });
      
      // Mark device as inactive
      if (this.onDeviceInactive) {
        this.onDeviceInactive(deviceId);
      }
      
      this.pendingAcks.delete(messageId);
    }, 30000);  // 30 second timeout

    // Store pending ACK
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

    // Clear timeout
    clearTimeout(pending.timeout);
    this.pendingAcks.delete(messageId);

    const deliveryTime = Date.now() - pending.timestamp;
    
    logger.info('✅ QoS 1 PUBACK confirmed', {
      deviceId: pending.deviceId,
      messageId,
      deliveryTime: `${deliveryTime}ms`,
      pendingCount: this.pendingAcks.size
    });

    // Mark device as active (responsive)
    if (this.onDeviceActive) {
      this.onDeviceActive(pending.deviceId);
    }
  }

  private extractDeviceIdFromTopic(topic: string): string | null {
    // Extract from pattern: statsnapp/DEVICE_ID/suffix
    const match = topic.match(/statsnapp\/([^\/]+)\//);
    return match ? match[1] : null;
  }

  getPendingAckCount(): number {
    return this.pendingAcks.size;
  }
}
