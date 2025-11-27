/**
 * Device Model - Mongoose schema for Device collection
 * Matches Prisma schema from Next.js web app
 */

import mongoose, { Document, Schema } from 'mongoose';

export enum DeviceStatus {
  UNALLOCATED = 'UNALLOCATED',
  ALLOCATED = 'ALLOCATED',
  PROVISIONING = 'PROVISIONING',
  PROVISIONED = 'PROVISIONED',
  ACTIVE = 'ACTIVE',
  OFFLINE = 'OFFLINE',
  ERROR = 'ERROR'
}

export interface IDevice extends Document {
  _id: mongoose.Types.ObjectId;
  userId?: mongoose.Types.ObjectId;
  
  // Core fields (shared with MQTT server)
  macID: string;
  crt?: string; // Certificate (populated after provisioning)
  ca_certificate?: string; // CA Certificate (populated after provisioning)
  clientId: string;
  
  // Provisioning flow fields (Next.js app specific)
  status: DeviceStatus;
  allocatedAt?: Date;
  provisionedAt?: Date;
  lastSeenAt?: Date;
  
  // Provisioning token fields (temporary, for provisioning flow)
  provisioningToken?: string;
  tokenExpiresAt?: Date;
  tokenUsed: boolean;
  
  // Certificate tracking
  certificateSerial?: string;
  certificateExpiresAt?: Date;
  
  // Error tracking
  errorMessage?: string;
  
  // Timestamps
  createdAt?: Date;
  updatedAt?: Date;
}

const DeviceSchema = new Schema<IDevice>({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: false
  },
  
  // Core fields
  macID: {
    type: String,
    required: true,
    unique: true
  },
  crt: {
    type: String,
    required: false
  },
  ca_certificate: {
    type: String,
    required: false
  },
  clientId: {
    type: String,
    required: true,
    unique: true
  },
  
  // Provisioning flow fields
  status: {
    type: String,
    enum: Object.values(DeviceStatus),
    default: DeviceStatus.UNALLOCATED,
    required: true
  },
  allocatedAt: {
    type: Date,
    required: false
  },
  provisionedAt: {
    type: Date,
    required: false
  },
  lastSeenAt: {
    type: Date,
    required: false
  },
  
  // Provisioning token fields
  provisioningToken: {
    type: String,
    required: false
  },
  tokenExpiresAt: {
    type: Date,
    required: false
  },
  tokenUsed: {
    type: Boolean,
    default: false,
    required: true
  },
  
  // Certificate tracking
  certificateSerial: {
    type: String,
    required: false
  },
  certificateExpiresAt: {
    type: Date,
    required: false
  },
  
  // Error tracking
  errorMessage: {
    type: String,
    required: false
  }
}, {
  timestamps: true, // Automatically adds createdAt and updatedAt
  collection: 'devices'
});

// Indexes (matching Prisma schema)
// Note: macID and clientId already have unique: true (auto-indexed)
DeviceSchema.index({ userId: 1 });
DeviceSchema.index({ status: 1 });

export const Device = mongoose.model<IDevice>('Device', DeviceSchema);
