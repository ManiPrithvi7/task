/**
 * LoyaltySession — browser join/WSS gate. Collection name avoids statsnapp Prisma collision.
 *
 * In-memory WS map (see LoyaltyService) assumes a single Node instance; Redis pub/sub is future work.
 */

import mongoose, { Document, Schema } from 'mongoose';

export enum LoyaltySessionStatus {
  CREATED = 'CREATED',
  READY = 'READY',
  SPINNING = 'SPINNING',
  COMPLETED = 'COMPLETED',
  EXPIRED = 'EXPIRED'
}

export const LOYALTY_ACTIVE_SESSION_STATUSES = [
  LoyaltySessionStatus.CREATED,
  LoyaltySessionStatus.READY,
  LoyaltySessionStatus.SPINNING
] as const;

export interface ILoyaltySession extends Document {
  sessionId: string;
  deviceId: string;
  status: LoyaltySessionStatus;
  expiresAt: Date;
  wsConnectedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const LoyaltySessionSchema = new Schema<ILoyaltySession>(
  {
    sessionId: { type: String, required: true, unique: true },
    deviceId: { type: String, required: true },
    status: {
      type: String,
      enum: Object.values(LoyaltySessionStatus),
      required: true,
      default: LoyaltySessionStatus.CREATED
    },
    expiresAt: { type: Date, required: true },
    wsConnectedAt: { type: Date, required: false }
  },
  { timestamps: true, collection: 'loyalty_sessions' }
);

LoyaltySessionSchema.index(
  { deviceId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: [...LOYALTY_ACTIVE_SESSION_STATUSES] }
    }
  }
);

export const LoyaltySession = mongoose.model<ILoyaltySession>('LoyaltySession', LoyaltySessionSchema);
