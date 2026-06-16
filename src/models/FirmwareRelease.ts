import mongoose, { Document, Schema } from 'mongoose';

export enum FirmwareReleaseStatus {
  DRAFT = 'DRAFT',
  STABLE = 'STABLE',
  DEPRECATED = 'DEPRECATED'
}

export enum FirmwareRolloutStrategy {
  ALL = 'ALL',
  ALLOWLIST = 'ALLOWLIST',
  PERCENTAGE = 'PERCENTAGE'
}

export interface IFirmwareRollout {
  strategy: FirmwareRolloutStrategy;
  deviceIds?: string[];
  userIds?: string[];
  percentage?: number;
  blockedDeviceIds?: string[];
}

export interface IFirmwareRelease extends Document {
  version: string;
  sha256: string;
  signature: string;
  objectKey: string;
  s3Key: string;
  sizeBytes: number;
  status: FirmwareReleaseStatus;
  rollout: IFirmwareRollout;
  minHardwareRev?: string;
  targetPlatforms?: string[];
  releasedAt: Date;
  createdBy: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const FirmwareReleaseSchema = new Schema<IFirmwareRelease>(
  {
    version: { type: String, required: true, unique: true },
    sha256: { type: String, required: true },
    signature: { type: String, required: true },
    objectKey: { type: String, required: true },
    s3Key: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
    status: { type: String, enum: Object.values(FirmwareReleaseStatus), required: true },
    rollout: { type: Schema.Types.Mixed, required: true },
    minHardwareRev: { type: String },
    targetPlatforms: { type: [String] },
    releasedAt: { type: Date, required: true },
    createdBy: { type: String, required: true }
  },
  { timestamps: true }
);

export const FirmwareRelease = mongoose.model<IFirmwareRelease>(
  'FirmwareRelease',
  FirmwareReleaseSchema
);
