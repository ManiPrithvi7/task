import { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { logger } from '../utils/logger';
import { MqttClientManager } from './mqttClient';

export class WebSocketServerManager {
  private wss: WebSocketServer;
  private mqttClient: MqttClientManager;
  private clients: Set<WebSocket> = new Set();

  constructor(httpServer: HttpServer, mqttClient: MqttClientManager) {
    this.mqttClient = mqttClient;
    this.wss = new WebSocketServer({ server: httpServer, path: '/ws' });
    this.setupWebSocketServer();
  }

  private setupWebSocketServer(): void {
    this.wss.on('connection', (ws: WebSocket) => {
      this.clients.add(ws);
      logger.info('WebSocket client connected', { total: this.clients.size });

      ws.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(ws, message);
        } catch (error: any) {
          logger.error('Failed to parse WebSocket message', { error: error.message });
          ws.send(JSON.stringify({ error: 'Invalid message format' }));
        }
      });

      ws.on('close', () => {
        this.clients.delete(ws);
        logger.info('WebSocket client disconnected', { total: this.clients.size });
      });

      ws.on('error', (error) => {
        logger.error('WebSocket error', { error: error.message });
      });

      // Send welcome message
      ws.send(JSON.stringify({
        type: 'connected',
        message: 'Connected to MQTT Publisher Lite WebSocket',
        timestamp: new Date().toISOString()
      }));
    });

    logger.info('WebSocket server initialized');
  }

  private async handleMessage(ws: WebSocket, message: any): Promise<void> {
    try {
      switch (message.type) {
        case 'subscribe':
          await this.handleSubscribe(ws, message);
          break;
        
        case 'publish':
          await this.handlePublish(ws, message);
          break;
        
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
          break;
        
        default:
          ws.send(JSON.stringify({ error: 'Unknown message type' }));
      }
    } catch (error: any) {
      logger.error('Error handling WebSocket message', { error: error.message });
      ws.send(JSON.stringify({ error: error.message }));
    }
  }

  private async handleSubscribe(ws: WebSocket, message: any): Promise<void> {
    const { topic } = message;
    
    if (!topic) {
      ws.send(JSON.stringify({ error: 'Topic is required' }));
      return;
    }

    await this.mqttClient.subscribe(topic, (receivedTopic, payload) => {
      // Broadcast to this WebSocket client
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'message',
          topic: receivedTopic,
          payload: payload.toString(),
          timestamp: new Date().toISOString()
        }));
      }
    });

    ws.send(JSON.stringify({
      type: 'subscribed',
      topic,
      timestamp: new Date().toISOString()
    }));

    logger.info('WebSocket client subscribed', { topic });
  }

  private async handlePublish(ws: WebSocket, message: any): Promise<void> {
    const { topic, payload, qos = 0, retain = false } = message;
    
    if (!topic || !payload) {
      ws.send(JSON.stringify({ error: 'Topic and payload are required' }));
      return;
    }

    await this.mqttClient.publish({
      topic,
      payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
      qos: qos as 0 | 1 | 2,
      retain
    });

    ws.send(JSON.stringify({
      type: 'published',
      topic,
      timestamp: new Date().toISOString()
    }));

    logger.debug('WebSocket client published', { topic });
  }

  broadcast(message: any): void {
    const data = JSON.stringify(message);
    let sent = 0;

    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
        sent++;
      }
    }

    logger.debug('Broadcast message', { clients: sent });
  }

  getClientCount(): number {
    return this.clients.size;
  }

  close(): void {
    for (const client of this.clients) {
      client.close();
    }
    this.wss.close();
    logger.info('WebSocket server closed');
  }
}
