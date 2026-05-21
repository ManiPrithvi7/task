import mongoose, { Document, Schema } from 'mongoose';
import { Provider } from './Social';

export enum CampaignStatus {
  DRAFT = 'DRAFT',
  ACTIVE = 'ACTIVE',
  PAUSED = 'PAUSED',
  ENDED = 'ENDED'
}

export interface ICampaign extends Document {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  name: string;
  offerCode: string;
  status: CampaignStatus;
  platform: Provider;
  startsAt?: Date;
  endsAt?: Date;
}

const CampaignSchema = new Schema<ICampaign>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true },
    offerCode: { type: String, required: true, unique: true },
    status: {
      type: String,
      enum: Object.values(CampaignStatus),
      default: CampaignStatus.DRAFT
    },
    platform: { type: String, enum: Object.values(Provider), required: true },
    startsAt: { type: Date },
    endsAt: { type: Date }
  },
  { timestamps: true, collection: 'campaigns' }
);

CampaignSchema.index({ userId: 1 });
CampaignSchema.index({ status: 1 });
CampaignSchema.index({ platform: 1 });

export const Campaign = mongoose.model<ICampaign>('Campaign', CampaignSchema);
