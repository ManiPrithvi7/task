import mongoose, { Document, Schema } from 'mongoose';

/** One row per Instagram Graph fetch attempt (success or failure). Collection: instagram_fetch_audit */
export interface IInstagramFetchAudit extends Document {
  deviceId: string;
  oldFollowers: number | null;
  newFollowers: number | null;
  fetchTimestamp: Date;
  success: boolean;
  error?: string | null;
}

const InstagramFetchAuditSchema = new Schema<IInstagramFetchAudit>(
  {
    deviceId: { type: String, required: true, index: true },
    oldFollowers: { type: Number, required: false, default: null },
    newFollowers: { type: Number, required: false, default: null },
    fetchTimestamp: { type: Date, required: true, default: Date.now, index: true },
    success: { type: Boolean, required: true },
    error: { type: String, default: null }
  },
  {
    timestamps: false,
    collection: 'instagram_fetch_audit'
  }
);

InstagramFetchAuditSchema.index({ deviceId: 1, fetchTimestamp: -1 });

export const InstagramFetchAudit = mongoose.model<IInstagramFetchAudit>(
  'InstagramFetchAudit',
  InstagramFetchAuditSchema
);
