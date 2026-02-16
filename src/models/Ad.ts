/**
 * Ad Model - Mongoose schema for Ad collection
 * Matches Prisma schema from Next.js web app
 *
 * NOTE: This is a READ-ONLY model for mqtt-publisher-lite.
 * Ad creation and management is handled by the Next.js web app.
 * The MQTT server reads ads to publish screen content to devices.
 */

import mongoose, { Document, Schema } from 'mongoose';

export enum AdStatus {
  DRAFT = 'DRAFT',
  SCHEDULED = 'SCHEDULED',
  RUNNING = 'RUNNING',
  PAUSED = 'PAUSED',
  ENDED = 'ENDED',
  ARCHIVED = 'ARCHIVED'
}

export enum AdType {
  PROMOTION = 'PROMOTION',
  BRAND_CANVAS = 'BRAND_CANVAS'
}

export interface IAd extends Document {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  templateId?: mongoose.Types.ObjectId;
  type: AdType;
  name: string;
  creativeType: string;
  creativeUrl: string;
  templateData: Record<string, any>;
  campaignId?: mongoose.Types.ObjectId;
  deviceId?: mongoose.Types.ObjectId;
  status: AdStatus;
  schedule: Record<string, any>;
  frequency: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

const AdSchema = new Schema<IAd>({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  templateId: {
    type: Schema.Types.ObjectId,
    ref: 'AdTemplate',
    required: false
  },
  type: {
    type: String,
    enum: Object.values(AdType),
    required: true
  },
  name: {
    type: String,
    required: true
  },
  creativeType: {
    type: String,
    default: 'IMAGE',
    required: true
  },
  creativeUrl: {
    type: String,
    required: true
  },
  templateData: {
    type: Schema.Types.Mixed,
    required: true
  },
  campaignId: {
    type: Schema.Types.ObjectId,
    ref: 'Campaign',
    required: false
  },
  deviceId: {
    type: Schema.Types.ObjectId,
    ref: 'Device',
    required: false
  },
  status: {
    type: String,
    enum: Object.values(AdStatus),
    default: AdStatus.DRAFT,
    required: true
  },
  schedule: {
    type: Schema.Types.Mixed, // JSON: { startDate, endDate?, timezone? }
    required: true
  },
  frequency: {
    type: Schema.Types.Mixed, // JSON: { interval, unit }
    required: true
  }
}, {
  timestamps: true, // Automatically adds createdAt and updatedAt
  collection: 'ads'
});

// Indexes (matching Prisma schema)
AdSchema.index({ userId: 1 });
AdSchema.index({ status: 1 });
AdSchema.index({ templateId: 1 });
AdSchema.index({ campaignId: 1 });
AdSchema.index({ deviceId: 1 });

export const Ad = mongoose.model<IAd>('Ad', AdSchema);
