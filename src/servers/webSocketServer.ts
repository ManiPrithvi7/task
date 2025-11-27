import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import { logger } from '../utils/logger';
import { MqttClientManager } from './mqttClient';

export class WebSocketServerManager {
  private wss: WebSocketServer;
  private mqttClient: MqttClientManager;
  private clients: Set<WebSocket> = new Set();

  constructor(server: Server, mqttClient: MqttClientManager) {
    this.mqttClient = mqttClient;
    this.wss = new WebSocketServer({ 
      server,
      path: '/ws'
    });

    this.setupEventHandlers();
    this.setupMqttBroadcast();

    logger.info('WebSocket server initialized on /ws');
  }

  private setupEventHandlers(): void {
    this.wss.on('connection', (ws: WebSocket, req) => {
      this.clients.add(ws);
      
      const clientIp = req.socket.remoteAddress || 'unknown';
      logger.info('WebSocket client connected', {
        clientIp,
        totalClients: this.clients.size
      });

      // Send welcome message
      ws.send(JSON.stringify({
        type: 'connected',
        message: 'Connected to MQTT Publisher Lite WebSocket',
        timestamp: new Date().toISOString()
      }));

      ws.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(ws, message);
        } catch (error: any) {
          logger.error('Invalid WebSocket message', { error: error.message });
          ws.send(JSON.stringify({
            type: 'error',
            error: 'Invalid JSON message',
            timestamp: new Date().toISOString()
          }));
        }
      });

      ws.on('close', () => {
        this.clients.delete(ws);
        logger.info('WebSocket client disconnected', {
          totalClients: this.clients.size
        });
      });

      ws.on('error', (error) => {
        logger.error('WebSocket error', { error: error.message });
        this.clients.delete(ws);
      });
    });
  }

  private handleMessage(ws: WebSocket, message: any): void {
    switch (message.type) {
      case 'subscribe':
        // Client wants to subscribe to specific topics
        logger.info('WebSocket client subscription request', {
          topics: message.topics
        });
        ws.send(JSON.stringify({
          type: 'subscribed',
          topics: message.topics,
          timestamp: new Date().toISOString()
        }));
        break;

      case 'publish':
        // Client wants to publish via WebSocket
        if (message.topic && message.payload) {
          this.mqttClient.publish({
            topic: message.topic,
            payload: typeof message.payload === 'string' 
              ? message.payload 
              : JSON.stringify(message.payload),
            qos: message.qos || 0,
            retain: message.retain || false
          }, {
            direction: 'server_to_client',
            source: 'websocket',
            timestamp: new Date().toISOString()
          }).then(() => {
            ws.send(JSON.stringify({
              type: 'published',
              topic: message.topic,
              timestamp: new Date().toISOString()
            }));
          }).catch(error => {
            ws.send(JSON.stringify({
              type: 'error',
              error: error.message,
              timestamp: new Date().toISOString()
            }));
          });
        }
        break;

      case 'ping':
        ws.send(JSON.stringify({
          type: 'pong',
          timestamp: new Date().toISOString()
        }));
        break;

      default:
        ws.send(JSON.stringify({
          type: 'error',
          error: `Unknown message type: ${message.type}`,
          timestamp: new Date().toISOString()
        }));
    }
  }

  private setupMqttBroadcast(): void {
    // Broadcast MQTT messages to all WebSocket clients
    this.mqttClient.on('messageReceived', (message: any) => {
      this.broadcast({
        ...message,
        source: 'mqtt_received'
      });
    });

    this.mqttClient.on('messagePublished', (message: any) => {
      this.broadcast({
        ...message,
        source: 'mqtt_published'
      });
    });
  }

  private broadcast(message: any): void {
    const messageStr = JSON.stringify(message);
    
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(messageStr);
        } catch (error: any) {
          logger.error('Failed to send to WebSocket client', {
            error: error.message
          });
        }
      }
    }
  }

  getClientCount(): number {
    return this.clients.size;
  }

  close(): void {
    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();
    this.wss.close();
    logger.info('WebSocket server closed');
  }
}

