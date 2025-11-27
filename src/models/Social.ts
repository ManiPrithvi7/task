/**
 * Social Model - Mongoose schema for Social collection
 * Based on Prisma schema provided
 */

import mongoose, { Document, Schema } from 'mongoose';

export enum Provider {
  INSTAGRAM = 'INSTAGRAM'
}

export interface ISocial extends Document {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  socialAccountId: string;
  provider: Provider;
  primary: boolean;
  accessToken: string;
  refreshToken: string;
  tokenExp: string;
  tokenCreatedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

const SocialSchema = new Schema<ISocial>({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  socialAccountId: {
    type: String,
    required: true
  },
  provider: {
    type: String,
    enum: Object.values(Provider),
    default: Provider.INSTAGRAM,
    required: true
  },
  primary: {
    type: Boolean,
    default: false,
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
  collection: 'socials'
});

// Indexes (only define indexes not already set via 'unique: true' in schema)
// Note: socialAccountId already has unique: true in schema definition
SocialSchema.index({ userId: 1 });
SocialSchema.index({ userId: 1, primary: 1 }); // Compound index for primary social lookup
SocialSchema.index({ provider: 1 });

export const Social = mongoose.model<ISocial>('Social', SocialSchema);

