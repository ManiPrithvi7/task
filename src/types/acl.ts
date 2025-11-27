/**
 * ACL (Access Control List) Types
 * Defines the structure for device permissions and tier-based access control
 */

export interface ACLRule {
  action: 'publish' | 'subscribe';
  topic: string;
  allow: boolean;
}

export interface DeviceACL {
  rules: ACLRule[];
  tier: DeviceTier;
  last_updated: string;
  device_id: string;
  user_id: string;
}

// DeviceTier is now imported from models
// export type DeviceTier = '1' | '2' | '3';
export type DeviceTier = '1' | '2' | '3';

export interface TierPermissions {
  tier: DeviceTier;
  name: string;
  description: string;
  rules: ACLRule[];
}

export interface CertificateInfo {
  device_id: string;
  user_id: string;
  certificate: string;
  private_key: string;
  ca_certificate: string;
  created_at: string;
  expires_at: string;
  status: 'active' | 'revoked' | 'expired';
}

export interface DeviceConnectionInfo {
  device_id: string;
  client_id: string;
  cn: string; // Common Name from certificate
  tier: DeviceTier;
  connected_at: string;
  last_seen: string;
  status: 'online' | 'offline' | 'away';
}

export interface ACLCacheEntry {
  device_id: string;
  rules: ACLRule[];
  tier: DeviceTier;
  cached_at: string;
  expires_at: string;
}

export interface RedisACLData {
  rules: string; // JSON stringified ACLRule[]
  tier: DeviceTier;
  last_updated: string;
  device_id: string;
  user_id: string;
  [key: string]: string; // Index signature for Redis compatibility
}

export interface ACLValidationResult {
  allowed: boolean;
  reason?: string;
  rule?: ACLRule;
  tier: DeviceTier;
}

export interface TierUpgradeRequest {
  device_id: string;
  user_id: string;
  from_tier: DeviceTier;
  to_tier: DeviceTier;
  requested_at: string;
  reason?: string;
}

export interface ACLStats {
  total_devices: number;
  devices_by_tier: Record<DeviceTier, number>;
  cache_hit_rate: number;
  last_updated: string;
}

