/**
 * User Model - Mongoose schema for User collection
 * Matches Prisma schema from Next.js web app
 *
 * NOTE: This is a READ-ONLY model for mqtt-publisher-lite.
 * User creation and management is handled by the Next.js web app.
 * We only query users to verify existence during provisioning.
 */

import mongoose, { Document, Schema } from 'mongoose';

export interface IUser extends Document {
  _id: mongoose.Types.ObjectId;
  name?: string;
  email?: string;
  emailVerified?: Date;
  image?: string;
  password?: string;
  isTwoFactorEnabled: boolean;

  // Action Screen preferences (mutually exclusive toggles)
  adManagementEnabled: boolean;
  brandCanvasEnabled: boolean;

  // Cookie consent preferences (GDPR compliant)
  cookieConsentAccepted?: boolean | null;
  cookieConsentTimestamp?: Date;
  cookiePreferences?: Record<string, any>;

  createdAt?: Date;
  updatedAt?: Date;
}

const UserSchema = new Schema<IUser>({
  name: {
    type: String,
    required: false
  },
  email: {
    type: String,
    required: false,
    sparse: true // Allows multiple null values
  },
  emailVerified: {
    type: Date,
    required: false
  },
  image: {
    type: String,
    required: false
  },
  password: {
    type: String,
    required: false
  },
  isTwoFactorEnabled: {
    type: Boolean,
    default: false,
    required: true
  },

  // Action Screen preferences (mutually exclusive toggles)
  adManagementEnabled: {
    type: Boolean,
    default: true,
    required: true
  },
  brandCanvasEnabled: {
    type: Boolean,
    default: false,
    required: true
  },

  // Cookie consent preferences (GDPR compliant)
  cookieConsentAccepted: {
    type: Boolean,
    required: false,
    default: null
  },
  cookieConsentTimestamp: {
    type: Date,
    required: false
  },
  cookiePreferences: {
    type: Schema.Types.Mixed, // JSON: { necessary: boolean, analytics: boolean, marketing: boolean }
    required: false
  }
}, {
  timestamps: true, // Automatically adds createdAt and updatedAt
  collection: 'User' // Prisma uses capitalized collection name
});

// Indexes
// Note: email has sparse: true in schema (allows multiple null values with unique constraint)
// Note: _id is automatically indexed by MongoDB

export const User = mongoose.model<IUser>('User', UserSchema);

