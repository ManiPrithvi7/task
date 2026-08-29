/**
 * DeviceOtaState Model - server-owned OTA runtime state per device.
 * These fields were evicted from the Prisma-owned Device model; one doc per
 * device, keyed by deviceId (the device's clientId).
 */

import mongoose, { Document, Schema } from 'mongoose';

export enum DeviceOtaStatus {
  IDLE = 'idle',
  NOTIFIED = 'notified',
  DOWNLOADING = 'downloading',
  VALIDATING = 'validating',
  ROLLBACK_REPORTED = 'rollback_reported'
}

export interface IDeviceOtaState extends Document {
  _id: mongoose.Types.ObjectId;
  deviceId: string;

  // OTA tracking (otaState is telemetry-only — not used for eligibility)
  firmwareVersion?: string;
  firmwareReportedAt?: Date;
  otaLastCheckAt?: Date;
  otaState?: DeviceOtaStatus;
  otaTargetVersion?: string;
  otaBlockedVersions?: string[];
  otaRollbackFailures?: Map<string, number>;

  createdAt?: Date;
  updatedAt?: Date;
}

const DeviceOtaStateSchema = new Schema<IDeviceOtaState>({
  deviceId: {
    type: String,
    required: true,
    unique: true
  },
  firmwareVersion: { type: String, required: false },
  firmwareReportedAt: { type: Date, required: false },
  otaLastCheckAt: { type: Date, required: false },
  otaState: {
    type: String,
    enum: Object.values(DeviceOtaStatus),
    required: false
  },
  otaTargetVersion: { type: String, required: false },
  otaBlockedVersions: [{ type: String }],
  otaRollbackFailures: {
    type: Map,
    of: Number,
    default: undefined
  }
}, {
  timestamps: true,
  collection: 'device_ota_states'
});

export const DeviceOtaState = mongoose.model<IDeviceOtaState>('DeviceOtaState', DeviceOtaStateSchema);
