import mongoose, { Document, Schema } from 'mongoose';

export interface IGoogleBusinessProfile extends Document {
  _id: mongoose.Types.ObjectId;
  socialId: mongoose.Types.ObjectId;
  accountId: string;
  accountName?: string;
  // Pub/Sub NEW_REVIEW registration (My Business Notifications API)
  notificationRegisteredAt?: Date;
  notificationRegisterError?: string;
  notificationTopic?: string;
  // Velocity + review history baseline (survives reconnect when profile row remains)
  gmb_reviewBaseline?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

const GoogleBusinessProfileSchema = new Schema<IGoogleBusinessProfile>(
  {
    socialId: { type: Schema.Types.ObjectId, required: true, unique: true },
    accountId: { type: String, required: true },
    accountName: { type: String, required: false },
    notificationRegisteredAt: { type: Date, required: false },
    notificationRegisterError: { type: String, required: false },
    notificationTopic: { type: String, required: false },
    gmb_reviewBaseline: { type: Number, required: false, default: 0 }
  },
  { timestamps: true, collection: 'GoogleBusinessProfile' }
);

export const GoogleBusinessProfile = mongoose.model<IGoogleBusinessProfile>(
  'GoogleBusinessProfile',
  GoogleBusinessProfileSchema
);
