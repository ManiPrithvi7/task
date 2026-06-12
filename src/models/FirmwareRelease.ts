/**
 * FirmwareRelease — OTA artifact metadata (binary stored in S3).
 */

import mongoose, { Document, Schema } from 'mongoose';

export enum FirmwareReleaseStatus {
  DRAFT = 'draft',
  STABLE = 'stable',
  DEPRECATED = 'deprecated'
}

export enum FirmwareRolloutStrategy {
  ALL = 'all',
  PERCENTAGE = 'percentage',
  ALLOWLIST = 'allowlist'
}

export interface IFirmwareRollout {
  strategy: FirmwareRolloutStrategy;
  percentage?: number;
  deviceIds?: string[];
  userIds?: string[];
  blockedDeviceIds?: string[];
}

export interface IFirmwareRelease extends Document {
  version: string;
  sha256: string;
  signature: string;
  s3Key: string;
  sizeBytes: number;
  minHardwareRev?: string;
  targetPlatforms?: string[];
  status: FirmwareReleaseStatus;
  rollout: IFirmwareRollout;
  releasedAt?: Date;
  createdBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const FirmwareRolloutSchema = new Schema<IFirmwareRollout>(
  {
    strategy: {
      type: String,
      enum: Object.values(FirmwareRolloutStrategy),
      default: FirmwareRolloutStrategy.ALL,
      required: true
    },
    percentage: { type: Number, min: 0, max: 100 },
    deviceIds: [{ type: String }],
    userIds: [{ type: String }],
    blockedDeviceIds: [{ type: String }]
  },
  { _id: false }
);

const FirmwareReleaseSchema = new Schema<IFirmwareRelease>(
  {
    version: { type: String, required: true, unique: true, trim: true },
    sha256: { type: String, required: true, trim: true },
    signature: { type: String, required: true },
    s3Key: { type: String, required: true, trim: true },
    sizeBytes: { type: Number, required: true, min: 1 },
    minHardwareRev: { type: String },
    targetPlatforms: [{ type: String }],
    status: {
      type: String,
      enum: Object.values(FirmwareReleaseStatus),
      default: FirmwareReleaseStatus.DRAFT,
      required: true
    },
    rollout: { type: FirmwareRolloutSchema, default: () => ({ strategy: FirmwareRolloutStrategy.ALL }) },
    releasedAt: { type: Date },
    createdBy: { type: String }
  },
  {
    timestamps: true,
    collection: 'firmware_releases'
  }
);

FirmwareReleaseSchema.index({ status: 1, version: -1 });

export const FirmwareRelease = mongoose.model<IFirmwareRelease>(
  'FirmwareRelease',
  FirmwareReleaseSchema
);
