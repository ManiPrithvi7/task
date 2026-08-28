/**
 * LoyaltySpin — Node copy of a statsnapp-provided result + MQTT lifecycle.
 * Collection `loyalty_spins` does not collide with Prisma LoyaltySpin.
 */

import mongoose, { Document, Schema } from 'mongoose';

export enum LoyaltySpinStatus {
  CREATED = 'CREATED',
  COMMAND_PUBLISHED = 'COMMAND_PUBLISHED',
  ACK_RECEIVED = 'ACK_RECEIVED',
  REVEALED = 'REVEALED',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED'
}

export const LOYALTY_IN_FLIGHT_SPIN_STATUSES = [
  LoyaltySpinStatus.CREATED,
  LoyaltySpinStatus.COMMAND_PUBLISHED,
  LoyaltySpinStatus.ACK_RECEIVED
] as const;

export interface ILoyaltySpinResult {
  digits: number[];
  value: string;
  reward: string;
}

export interface ILoyaltySpin extends Document {
  spinId: string;
  sessionId: string;
  deviceId: string;
  result: ILoyaltySpinResult;
  status: LoyaltySpinStatus;
  idempotencyKey: string;
  commandPublishedAt?: Date;
  ackReceivedAt?: Date;
  startedAt?: Date;
  ttlMs: number;
  revealAt?: Date;
  issuedAt?: Date;
  expiresAt?: Date;
  failCode?: string;
  failMessage?: string;
  createdAt: Date;
  updatedAt: Date;
}

const LoyaltySpinResultSchema = new Schema<ILoyaltySpinResult>(
  {
    digits: { type: [Number], required: true },
    value: { type: String, required: true },
    reward: { type: String, required: true }
  },
  { _id: false }
);

const LoyaltySpinSchema = new Schema<ILoyaltySpin>(
  {
    spinId: { type: String, required: true, unique: true },
    sessionId: { type: String, required: true, index: true },
    deviceId: { type: String, required: true },
    result: { type: LoyaltySpinResultSchema, required: true },
    status: {
      type: String,
      enum: Object.values(LoyaltySpinStatus),
      required: true,
      default: LoyaltySpinStatus.CREATED
    },
    idempotencyKey: { type: String, required: true },
    commandPublishedAt: { type: Date, required: false },
    ackReceivedAt: { type: Date, required: false },
    startedAt: { type: Date, required: false },
    ttlMs: { type: Number, required: true },
    revealAt: { type: Date, required: false },
    issuedAt: { type: Date, required: false },
    expiresAt: { type: Date, required: false },
    failCode: { type: String, required: false },
    failMessage: { type: String, required: false }
  },
  { timestamps: true, collection: 'loyalty_spins' }
);

LoyaltySpinSchema.index({ sessionId: 1, idempotencyKey: 1 }, { unique: true });
LoyaltySpinSchema.index(
  { deviceId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: [...LOYALTY_IN_FLIGHT_SPIN_STATUSES] }
    }
  }
);
LoyaltySpinSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

export const LoyaltySpin = mongoose.model<ILoyaltySpin>('LoyaltySpin', LoyaltySpinSchema);
