/**
 * TransparencyEntry Model - Certificate Transparency Log with Merkle Tree
 * 
 * PKI Improvement #7: Internal Certificate Transparency Log
 * 
 * Each entry records a certificate issuance in an append-only Merkle tree.
 * - leafHash: SHA-256 of the certificate data
 * - rootHash: Current Merkle tree root after insertion
 * - inclusionProof: Array of sibling hashes proving leaf is in the tree
 */

import mongoose, { Document, Schema } from 'mongoose';

export interface ITransparencyEntry extends Document {
  _id: mongoose.Types.ObjectId;
  /** Monotonically increasing index (leaf position in tree) */
  index: number;
  /** SHA-256 hash of (certFingerprint + serialNumber + cn + timestamp) */
  leafHash: string;
  /** Merkle tree root hash after this entry was added */
  rootHash: string;
  /** Inclusion proof: array of {hash, position} pairs for verification */
  inclusionProof: Array<{ hash: string; position: 'left' | 'right' }>;
  /** Certificate fingerprint (links to DeviceCertificate) */
  certFingerprint: string;
  /** Certificate serial number */
  serialNumber: string;
  /** Certificate CN */
  cn: string;
  /** Device ID */
  deviceId: string;
  /** Timestamp of issuance */
  issuedAt: Date;
}

const TransparencyEntrySchema = new Schema<ITransparencyEntry>({
  index: {
    type: Number,
    required: true,
    unique: true
  },
  leafHash: {
    type: String,
    required: true
  },
  rootHash: {
    type: String,
    required: true
  },
  inclusionProof: [{
    hash: { type: String, required: true },
    position: { type: String, enum: ['left', 'right'], required: true }
  }],
  certFingerprint: {
    type: String,
    required: true
  },
  serialNumber: {
    type: String,
    required: true
  },
  cn: {
    type: String,
    required: true
  },
  deviceId: {
    type: String,
    required: true
  },
  issuedAt: {
    type: Date,
    required: true,
    default: Date.now
  }
}, {
  timestamps: false,
  collection: 'transparency_log'
});

TransparencyEntrySchema.index({ certFingerprint: 1 });
TransparencyEntrySchema.index({ deviceId: 1 });
TransparencyEntrySchema.index({ serialNumber: 1 });
TransparencyEntrySchema.index({ issuedAt: 1 });

export const TransparencyEntry = mongoose.model<ITransparencyEntry>('TransparencyEntry', TransparencyEntrySchema);
