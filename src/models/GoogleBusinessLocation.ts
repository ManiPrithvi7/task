import mongoose, { Document, Schema } from 'mongoose';

export interface IGoogleBusinessLocation extends Document {
  _id: mongoose.Types.ObjectId;
  profileId: mongoose.Types.ObjectId;
  locationId: string;
  locationName?: string;
  totalReviewCount?: number;
  averageRating?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

const GoogleBusinessLocationSchema = new Schema<IGoogleBusinessLocation>(
  {
    profileId: { type: Schema.Types.ObjectId, required: true },
    locationId: { type: String, required: true, unique: true },
    locationName: { type: String },
    totalReviewCount: { type: Number },
    averageRating: { type: Number }
  },
  { timestamps: true, collection: 'GoogleBusinessLocation' }
);

GoogleBusinessLocationSchema.index({ profileId: 1 });

export const GoogleBusinessLocation = mongoose.model<IGoogleBusinessLocation>(
  'GoogleBusinessLocation',
  GoogleBusinessLocationSchema
);
