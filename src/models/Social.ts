/**
 * Social Model - Mongoose schema for Social collection
 * Matches Prisma schema from Next.js web app
 *
 * NOTE: proofmqtt is READ-ONLY except for token refresh — it may update
 * accessToken/refreshToken/tokenExp/tokenCreatedAt for INSTAGRAM and
 * GOOGLE_BUSINESS providers. All other fields are managed by the Next.js app.
 */

import mongoose, { Document, Schema } from 'mongoose';

export enum Provider {
  INSTAGRAM = 'INSTAGRAM',
  GOOGLE_BUSINESS = 'GOOGLE_BUSINESS'
}

export interface ISocial extends Document {
  _id: mongoose.Types.ObjectId;
  businessId: mongoose.Types.ObjectId;
  socialAccountId: string;
  provider: Provider;
  accessToken: string;
  refreshToken: string;
  tokenExp: string;
  tokenCreatedAt?: Date;
  updatedAt?: Date;
  createdAt?: Date;
}

const SocialSchema = new Schema<ISocial>({
  businessId: {
    type: Schema.Types.ObjectId,
    ref: 'Business',
    required: true
  },
  socialAccountId: {
    type: String,
    required: true,
    unique: true
  },
  provider: {
    type: String,
    enum: Object.values(Provider),
    default: Provider.INSTAGRAM,
    required: true
  },
  accessToken: {
    type: String,
    required: true
  },
  refreshToken: {
    type: String,
    required: true
  },
  tokenExp: {
    type: String,
    required: true
  },
  tokenCreatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true, // Automatically adds createdAt and updatedAt
  /** Atlas / Prisma uses this exact name (not lowercase `socials`). */
  collection: 'Social'
});

// Indexes (matching Prisma: @@index([businessId, provider]); socialAccountId unique above)
SocialSchema.index({ businessId: 1, provider: 1 });

export const Social = mongoose.model<ISocial>('Social', SocialSchema);
