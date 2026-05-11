/**
 * Social Model - Mongoose schema for Social collection
 * Matches Prisma schema from Next.js web app
 *
 * NOTE: This is a READ-ONLY model for mqtt-publisher-lite.
 * Social account management is handled by the Next.js web app.
 */

import mongoose, { Document, Schema } from 'mongoose';

export enum Provider {
  INSTAGRAM = 'INSTAGRAM',
  GOOGLE_BUSINESS = 'GOOGLE_BUSINESS',
  SQUARE = 'SQUARE',
  SHOPIFY = 'SHOPIFY'
}

export interface ISocial extends Document {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  socialAccountId: string;
  provider: Provider;
  url?: string;
  profilePictureURL?: string;
  followerCount?: number;
  lastSyncedAt?: Date;
  accessToken: string;
  refreshToken: string;
  tokenExp: string;
  nfcCount: number;
  scanCount: number;
  tokenCreatedAt?: Date;
  updatedAt?: Date;
  createdAt?: Date;
}

const SocialSchema = new Schema<ISocial>({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
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
  url: {
    type: String,
    required: false
  },
  profilePictureURL: {
    type: String,
    required: false
  },
  followerCount: {
    type: Number,
    required: false
  },
  lastSyncedAt: {
    type: Date,
    required: false
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
  nfcCount: {
    type: Number,
    required: true,
    default: 0
  },
  scanCount: {
    type: Number,
    required: true,
    default: 0
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

// Indexes (matching Prisma schema). Collection name: `Social`.
SocialSchema.index({ userId: 1 });
SocialSchema.index({ provider: 1 });

export const Social = mongoose.model<ISocial>('Social', SocialSchema);

