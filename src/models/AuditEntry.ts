/**
 * AuditEntry Model - Tamper-proof certificate audit log with SHA-256 hash chaining
 * 
 * Each entry contains:
 * - sequence: Monotonically increasing counter (unique)
 * - hash: SHA-256 of this entry's content
 * - previousHash: SHA-256 hash of the prior entry (chain link)
 * - signature: Optional HSM signature at chain roots (Phase 2)
 * 
 * PKI Improvement #3: Audit Log Is Append-Only, Not Tamper-Proof → Signed + Hash-Chained
 */

import mongoose, { Document, Schema } from 'mongoose';

export enum AuditEventType {
  CERTIFICATE_ISSUED = 'CERTIFICATE_ISSUED',
  CERTIFICATE_REPLACED = 'CERTIFICATE_REPLACED',
  CERTIFICATE_REVOKED = 'CERTIFICATE_REVOKED',
  CERTIFICATE_EXPIRED = 'CERTIFICATE_EXPIRED',
  CERTIFICATE_RENEWED = 'CERTIFICATE_RENEWED',
  CERTIFICATE_GRACE_ACCEPTED = 'CERTIFICATE_GRACE_ACCEPTED',
  CSR_RECEIVED = 'CSR_RECEIVED',
  CSR_REJECTED = 'CSR_REJECTED',
  CSR_RATE_LIMITED = 'CSR_RATE_LIMITED',
  ROOT_CA_GENERATED = 'ROOT_CA_GENERATED',
  INTERMEDIATE_CA_GENERATED = 'INTERMEDIATE_CA_GENERATED',
  CHAIN_VALIDATION_SUCCESS = 'CHAIN_VALIDATION_SUCCESS',
  CHAIN_VALIDATION_FAILED = 'CHAIN_VALIDATION_FAILED',
  KU_EKU_VALIDATION_SUCCESS = 'KU_EKU_VALIDATION_SUCCESS',
  KU_EKU_VALIDATION_FAILED = 'KU_EKU_VALIDATION_FAILED',
  DEVICE_AUTH_SUCCESS = 'DEVICE_AUTH_SUCCESS',
  DEVICE_AUTH_FAILED = 'DEVICE_AUTH_FAILED',
  TRANSPARENCY_LOG_ENTRY = 'TRANSPARENCY_LOG_ENTRY',
  INTEGRITY_CHECK_PASSED = 'INTEGRITY_CHECK_PASSED',
  INTEGRITY_CHECK_FAILED = 'INTEGRITY_CHECK_FAILED'
}

export interface IAuditEntry extends Document {
  _id: mongoose.Types.ObjectId;
  sequence: number;
  timestamp: Date;
  event: AuditEventType;
  deviceId?: string;
  userId?: string;
  orderId?: string;
  batchId?: string;
  serialNumber?: string;
  certificateFingerprint?: string;
  details: Record<string, unknown>;
  previousHash: string;
  hash: string;
  /** HSM signature of chain root (populated at intervals — Phase 2) */
  signature?: string;
}

const AuditEntrySchema = new Schema<IAuditEntry>({
  sequence: {
    type: Number,
    required: true,
    unique: true,
    index: true
  },
  timestamp: {
    type: Date,
    required: true,
    default: Date.now
  },
  event: {
    type: String,
    enum: Object.values(AuditEventType),
    required: true
  },
  deviceId: {
    type: String,
    default: null
  },
  userId: {
    type: String,
    default: null
  },
  orderId: {
    type: String,
    default: null
  },
  batchId: {
    type: String,
    default: null
  },
  serialNumber: {
    type: String,
    default: null
  },
  certificateFingerprint: {
    type: String,
    default: null
  },
  details: {
    type: Schema.Types.Mixed,
    default: {}
  },
  previousHash: {
    type: String,
    required: true
  },
  hash: {
    type: String,
    required: true,
    unique: true
  },
  signature: {
    type: String,
    default: null
  }
}, {
  timestamps: false,
  collection: 'certificate_audit_v2'
});

// Indexes for efficient querying
AuditEntrySchema.index({ event: 1 });
AuditEntrySchema.index({ deviceId: 1 });
AuditEntrySchema.index({ orderId: 1 });
AuditEntrySchema.index({ batchId: 1 });
AuditEntrySchema.index({ timestamp: 1 });
AuditEntrySchema.index({ certificateFingerprint: 1 });

export const AuditEntry = mongoose.model<IAuditEntry>('AuditEntry', AuditEntrySchema);
