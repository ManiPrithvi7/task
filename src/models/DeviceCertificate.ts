/**
 * Device Certificate Model - Mongoose schema for Device Certificate collection
 * Stores device certificates and certificate metadata
 * Matches Prisma schema from Next.js web app
 */

import mongoose, { Document, Schema } from 'mongoose';

export enum DeviceCertificateStatus {
  active = 'active',
  revoked = 'revoked',
  expired = 'expired'
}

export interface IDeviceCertificate extends Document {
  _id: mongoose.Types.ObjectId;
  device_id: string;
  user_id: mongoose.Types.ObjectId;
  /** PKI Improvement #1: Order ID for supply chain traceability (structured CN) */
  order_id?: string;
  /** PKI Improvement #1: Batch ID for granular revocation (structured CN) */
  batch_id?: string;
  certificate: string;
  private_key: string; // Optional at issuance (device keeps key during CSR flow); may be empty
  ca_certificate: string;
  cn: string; // Common Name from certificate
  fingerprint: string; // Certificate fingerprint
  status: DeviceCertificateStatus;
  created_at: Date;
  expires_at: Date;
  revoked_at?: Date;
  last_used?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const DeviceCertificateSchema = new Schema<IDeviceCertificate>({
  device_id: {
    type: String,
    required: true,
    unique: true
  },
  user_id: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  order_id: {
    type: String,
    default: null
  },
  batch_id: {
    type: String,
    default: null
  },
  certificate: {
    type: String,
    required: true
  },
  private_key: {
    type: String,
    required: false, // Optional: device keeps private key during CSR signing; server stores '' when not available
    default: ''
  },
  ca_certificate: {
    type: String,
    required: true
  },
  cn: {
    type: String,
    required: true
  },
  fingerprint: {
    type: String,
    required: true,
    unique: true
  },
  status: {
    type: String,
    enum: Object.values(DeviceCertificateStatus),
    required: true,
    default: DeviceCertificateStatus.active
  },
  created_at: {
    type: Date,
    default: Date.now
  },
  expires_at: {
    type: Date,
    required: true
  },
  revoked_at: {
    type: Date,
    default: null
  },
  last_used: {
    type: Date,
    default: null
  }
}, {
  timestamps: true, // Automatically adds createdAt and updatedAt
  collection: 'device_certificates'
});

// Indexes (matching Prisma schema)
// Note: device_id already has unique: true in schema definition
// Note: fingerprint already has unique: true in schema definition
DeviceCertificateSchema.index({ user_id: 1 });
DeviceCertificateSchema.index({ cn: 1 });
DeviceCertificateSchema.index({ status: 1 });
DeviceCertificateSchema.index({ expires_at: 1 });
DeviceCertificateSchema.index({ created_at: 1 });
// PKI Improvement #1: Compound index for order/batch revocation queries
DeviceCertificateSchema.index({ order_id: 1, batch_id: 1 });

// Pre-save middleware to update status based on expiration
DeviceCertificateSchema.pre('save', function(next) {
  if (this.isModified('expires_at') || this.isNew) {
    const now = new Date();
    if (this.expires_at < now && this.status === DeviceCertificateStatus.active) {
      this.status = DeviceCertificateStatus.expired;
    }
  }
  next();
});

export const DeviceCertificate = mongoose.model<IDeviceCertificate>('DeviceCertificate', DeviceCertificateSchema);
