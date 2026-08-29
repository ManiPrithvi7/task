/**
 * FirmwareRelease — OTA artifact metadata (binary stored in Oracle Object Storage).
 */

import mongoose, { Document, Schema } from 'mongoose';

export enum FirmwareReleaseStatus {
  DRAFT = 'draft',
  STABLE = 'stable',
  DEPRECATED = 'deprecated',
  DEPRECATED_RETRYABLE = 'deprecated_retryable'
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
  businessIds?: string[];
  blockedDeviceIds?: string[];
}

export interface IFirmwareRelease extends Document {
  version: string;
  sha256: string;
  signature: string;
  objectKey: string;
  /** @deprecated Legacy alias — use objectKey */
  s3Key?: string;
  sizeBytes: number;
  minHardwareRev?: string;
  targetPlatforms?: string[];
  status: FirmwareReleaseStatus;
  rollout: IFirmwareRollout;
  /** Current staged rollout percentage (1/10/50/100). Synced with rollout.percentage. */
  currentPercentage: number;
  stageStartedAt?: Date;
  stageAttemptedCount: number;
  stageFailedCount: number;
  stageRolledBackCount: number;
  aborted: boolean;
  /** Durable previous active version for abort/halt restore (Mongo source of truth). */
  previousVersion?: string;
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
    businessIds: [{ type: String }],
    blockedDeviceIds: [{ type: String }]
  },
  { _id: false }
);

const FirmwareReleaseSchema = new Schema<IFirmwareRelease>(
  {
    version: { type: String, required: true, unique: true, trim: true },
    sha256: { type: String, required: true, trim: true },
    signature: { type: String, required: true },
    objectKey: { type: String, required: true, trim: true },
    s3Key: { type: String, trim: true },
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
    currentPercentage: { type: Number, min: 0, max: 100, default: 100 },
    stageStartedAt: { type: Date },
    stageAttemptedCount: { type: Number, default: 0, min: 0 },
    stageFailedCount: { type: Number, default: 0, min: 0 },
    stageRolledBackCount: { type: Number, default: 0, min: 0 },
    aborted: { type: Boolean, default: false },
    previousVersion: { type: String, trim: true, index: true },
    releasedAt: { type: Date },
    createdBy: { type: String }
  },
  {
    timestamps: true,
    collection: 'firmware_releases'
  }
);

FirmwareReleaseSchema.index({ status: 1, version: -1 });
FirmwareReleaseSchema.index({ status: 1, aborted: 1, currentPercentage: 1 });

export const FirmwareRelease = mongoose.model<IFirmwareRelease>(
  'FirmwareRelease',
  FirmwareReleaseSchema
);

/** One-shot backfill for docs created before stage tracking. */
export async function backfillFirmwareReleaseStageFields(): Promise<number> {
  const result = await FirmwareRelease.updateMany(
    {
      $or: [
        { currentPercentage: { $exists: false } },
        { aborted: { $exists: false } },
        { stageAttemptedCount: { $exists: false } }
      ]
    },
    [
      {
        $set: {
          aborted: { $ifNull: ['$aborted', false] },
          stageAttemptedCount: { $ifNull: ['$stageAttemptedCount', 0] },
          stageFailedCount: { $ifNull: ['$stageFailedCount', 0] },
          stageRolledBackCount: { $ifNull: ['$stageRolledBackCount', 0] },
          currentPercentage: {
            $ifNull: ['$currentPercentage', { $ifNull: ['$rollout.percentage', 100] }]
          },
          stageStartedAt: {
            $ifNull: ['$stageStartedAt', { $ifNull: ['$releasedAt', '$createdAt'] }]
          }
        }
      }
    ]
  );
  return result.modifiedCount ?? 0;
}
