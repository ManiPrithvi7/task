import mongoose, { Document, Schema } from 'mongoose';

export interface IGoogleBusinessLocation extends Document {
  _id: mongoose.Types.ObjectId;
  profileId: mongoose.Types.ObjectId;
  locationId: string;
  locationName: string;
  storeCode?: string;
  address?: string;
  phoneNumber?: string;
  websiteUrl?: string;
  regularHours?: Record<string, any>;
  openInfo?: Record<string, any>;
  isVerified: boolean;
  averageRating?: number;
  totalReviewCount?: number;
  /** When true, skip Business Information locations.get (consistent 404 for this row). */
  locationInfoUnavailable: boolean;
  lastSyncedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

const GoogleBusinessLocationSchema = new Schema<IGoogleBusinessLocation>(
  {
    profileId: { type: Schema.Types.ObjectId, required: true },
    locationId: { type: String, required: true, unique: true },
    locationName: { type: String, required: true },
    storeCode: { type: String },
    address: { type: String },
    phoneNumber: { type: String },
    websiteUrl: { type: String },
    regularHours: { type: Schema.Types.Mixed },
    openInfo: { type: Schema.Types.Mixed },
    isVerified: { type: Boolean, default: false },
    averageRating: { type: Number },
    totalReviewCount: { type: Number },
    locationInfoUnavailable: { type: Boolean, default: false },
    lastSyncedAt: { type: Date, default: Date.now }
  },
  { timestamps: true, collection: 'GoogleBusinessLocation' }
);

GoogleBusinessLocationSchema.index({ profileId: 1 });

export const GoogleBusinessLocation = mongoose.model<IGoogleBusinessLocation>(
  'GoogleBusinessLocation',
  GoogleBusinessLocationSchema
);
