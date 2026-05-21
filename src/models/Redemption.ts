import mongoose, { Document, Schema } from 'mongoose';
import { Provider } from './Social';

export interface IRedemption extends Document {
  _id: mongoose.Types.ObjectId;
  campaignId: mongoose.Types.ObjectId;
  offerCode: string;
  platform: Provider;
  orderId: string;
  orderAmountCents: number;
  discountAmountCents: number;
  redeemedAt: Date;
}

const RedemptionSchema = new Schema<IRedemption>(
  {
    campaignId: { type: Schema.Types.ObjectId, required: true },
    offerCode: { type: String, required: true },
    platform: { type: String, enum: Object.values(Provider), required: true },
    orderId: { type: String, required: true },
    orderAmountCents: { type: Number, required: true },
    discountAmountCents: { type: Number, required: true },
    redeemedAt: { type: Date, default: Date.now }
  },
  { timestamps: false, collection: 'redemptions' }
);

RedemptionSchema.index({ campaignId: 1, orderId: 1 }, { unique: true });

export const Redemption = mongoose.model<IRedemption>('Redemption', RedemptionSchema);
