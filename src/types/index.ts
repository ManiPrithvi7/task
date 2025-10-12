// Session Types
export interface SessionData {
  clientId: string;
  active_account: string;
  social_accounts: Array<{
    type: string;
    account_id: string;
    postArray: string;
  }>;
  access_token: string;
  createdAt: string;
  expiresAt: string;
}

// Device Types
export interface Device {
  deviceId: string;
  clientId: string;
  username: string;
  status: 'active' | 'inactive';
  lastSeen: string;
  metadata?: Record<string, any>;
  lastMilestone?: number;
}

// User Types
export interface User {
  userId: string;
  username: string;
  email?: string;
  devices: string[];
  createdAt: string;
}

// ACL Types
export interface ACLRule {
  username: string;
  topic: string;
  access: 'pub' | 'sub' | 'pubsub';
}

// MQTT Message Types
export interface MqttMessage {
  topic: string;
  payload: string | Buffer;
  qos: 0 | 1 | 2;
  retain: boolean;
}

// Stats Message Types
export interface StatsMessage {
  type: 'metrics' | 'alert' | 'status';
  deviceId: string;
  timestamp: string;
  data: Record<string, any>;
}

// Message Direction Types
export type MessageDirection = 
  | 'client_to_server'    // Device/client publishes to server
  | 'server_to_client'    // Server publishes to device/client
  | 'broker_to_server'    // Server receives from broker
  | 'server_to_broker';   // Server publishes to broker

// Message Source Types
export type MessageSource = 
  | 'http_api'           // Message originated from HTTP API
  | 'websocket'          // Message originated from WebSocket
  | 'backend'            // Message originated from backend logic
  | 'broker'             // Message originated from MQTT broker
  | 'device'             // Message originated from a device
  | 'system';            // System-generated message

// Enhanced Message Metadata
export interface MessageMetadata {
  direction: MessageDirection;
  source: MessageSource;
  deviceId?: string;
  initiator?: string;
  timestamp: string;
  byteSize?: number;
  packetId?: number;
  deliveryTime?: number;
}

// Enhanced MQTT Message with Metadata
export interface EnhancedMqttMessage extends MqttMessage {
  metadata: MessageMetadata;
}

// WebSocket Message Format
export interface WebSocketMessage {
  type: 'message' | 'connected' | 'subscribed' | 'published' | 'error' | 'pong';
  topic?: string;
  payload?: string;
  qos?: 0 | 1 | 2;
  retain?: boolean;
  direction?: MessageDirection;
  source?: MessageSource;
  deviceId?: string;
  timestamp: string;
  byteSize?: number;
  packetId?: number;
  deliveryTime?: number;
  message?: string;
  error?: string;
}
