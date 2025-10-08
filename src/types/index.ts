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
