/**
 * Business Model - Mongoose schema for Business collection
 * Matches Prisma schema from Next.js web app
 *
 * NOTE: This is a READ-ONLY model for mqtt-publisher-lite.
 * Business creation and management is handled by the Next.js web app.
 * We only query businesses to verify existence during provisioning.
 */

import mongoose, { Document, Schema } from 'mongoose';

export interface IBusiness extends Document {
  _id: mongoose.Types.ObjectId;
  name?: string;
  email?: string;
  emailVerified?: Date;
  image?: string;
  password?: string;
  isTwoFactorEnabled: boolean;

  // Cookie consent preferences (GDPR compliant)
  cookieConsentAccepted?: boolean | null;
  cookieConsentTimestamp?: Date;
  cookiePreferences?: Record<string, any>;

  createdAt?: Date;
  updatedAt?: Date;
}

const BusinessSchema = new Schema<IBusiness>({
  name: {
    type: String,
    required: false
  },
  email: {
    type: String,
    required: false,
    unique: true,
    sparse: true // Prisma: email String? @unique — sparse allows multiple docs without an email
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
  timestamps: true,
  collection: 'Business' // Prisma default collection name
});

export const Business = mongoose.model<IBusiness>('Business', BusinessSchema);
