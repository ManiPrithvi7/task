import mongoose, { Document, Schema } from 'mongoose';

export interface IGoogleBusinessReview extends Document {
  _id: mongoose.Types.ObjectId;
  locationId: mongoose.Types.ObjectId;
  reviewId: string;
  starRating: number;
  comment?: string;
  reviewerName?: string;
  createTime: Date;
  updateTime: Date;
  notificationReceived?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

const GoogleBusinessReviewSchema = new Schema<IGoogleBusinessReview>(
  {
    locationId: { type: Schema.Types.ObjectId, required: true },
    reviewId: { type: String, required: true, unique: true },
    starRating: { type: Number, required: true },
    comment: { type: String },
    reviewerName: { type: String },
    createTime: { type: Date, required: true },
    updateTime: { type: Date, required: true },
    notificationReceived: { type: Boolean, default: false }
  },
  { timestamps: true, collection: 'GoogleBusinessReview' }
);

GoogleBusinessReviewSchema.index({ locationId: 1 });

export const GoogleBusinessReview = mongoose.model<IGoogleBusinessReview>(
  'GoogleBusinessReview',
  GoogleBusinessReviewSchema
);
