/**
 * Type definitions for MQTT Publisher Lite
 */

export interface DeviceInfo {
  deviceId: string;
  clientId: string;
  username: string;
  status: 'active' | 'inactive';
  lastSeen: string;
  metadata?: {
    deviceType?: string;
    os?: string;
    appVersion?: string;
    registeredAt?: string;
    ipAddress?: string;
    userAgent?: string;
  };
}

export interface SessionInfo {
  sessionId: string;
  userId: string;
  deviceId: string;
  createdAt: string;
  expiresAt: string;
  data?: Record<string, any>;
}

export interface UserInfo {
  userId: string;
  username?: string;
  email?: string;
  devices: string[];
  createdAt: string;
  lastLogin?: string;
}

export interface MqttMessage {
  topic: string;
  payload: string;
  qos?: 0 | 1 | 2;
  retain?: boolean;
}

export interface PublishOptions {
  direction: 'server_to_client' | 'client_to_server' | 'broker_to_server';
  source: string;
  deviceId?: string;
  timestamp: string;
  initiator?: string;
}

