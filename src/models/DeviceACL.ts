/**
 * Device ACL Model - Mongoose schema for Device ACL collection
 * Stores device access control lists and tier information
 * Matches Prisma schema from Next.js web app
 */

import mongoose, { Document, Schema } from 'mongoose';

// Device tier levels for ACL (matching Prisma enum)
export enum DeviceTier {
  TIER_1 = '1',
  TIER_2 = '2',
  TIER_3 = '3'
}

export interface ACLRule {
  action: 'publish' | 'subscribe';
  topic: string;
  allow: boolean;
}

export interface IDeviceACL extends Document {
  _id: mongoose.Types.ObjectId;
  device_id: string;
  user_id: mongoose.Types.ObjectId;
  tier: DeviceTier;
  rules: ACLRule[];
  last_updated: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ACLRuleSchema = new Schema({
  action: {
    type: String,
    enum: ['publish', 'subscribe'],
    required: true
  },
  topic: {
    type: String,
    required: true
  },
  allow: {
    type: Boolean,
    required: true
  }
}, { _id: false });

const DeviceACLSchema = new Schema<IDeviceACL>({
  device_id: {
    type: String,
    required: true,
    unique: true
  },
  user_id: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  tier: {
    type: String,
    enum: Object.values(DeviceTier),
    required: true,
    default: DeviceTier.TIER_1
  },
  rules: {
    type: [ACLRuleSchema],
    required: true,
    default: []
  },
  last_updated: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true, // Automatically adds createdAt and updatedAt
  collection: 'device_acls'
});

// Indexes (matching Prisma schema)
// Note: device_id already has unique: true in schema definition
DeviceACLSchema.index({ user_id: 1 });
DeviceACLSchema.index({ tier: 1 });
DeviceACLSchema.index({ last_updated: 1 });

export const DeviceACL = mongoose.model<IDeviceACL>('DeviceACL', DeviceACLSchema);
