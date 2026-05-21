import mongoose, { Document, Schema } from 'mongoose';

export interface IGoogleBusinessProfile extends Document {
  _id: mongoose.Types.ObjectId;
  socialId: mongoose.Types.ObjectId;
  accountId: string;
  accountName?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const GoogleBusinessProfileSchema = new Schema<IGoogleBusinessProfile>(
  {
    socialId: { type: Schema.Types.ObjectId, required: true, unique: true },
    accountId: { type: String, required: true }
  },
  { timestamps: true, collection: 'GoogleBusinessProfile' }
);

export const GoogleBusinessProfile = mongoose.model<IGoogleBusinessProfile>(
  'GoogleBusinessProfile',
  GoogleBusinessProfileSchema
);
