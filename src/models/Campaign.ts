import mongoose, { Document, Schema } from 'mongoose';
import { Provider } from './Social';

export enum CampaignStatus {
  DRAFT = 'DRAFT',
  ACTIVE = 'ACTIVE',
  PAUSED = 'PAUSED',
  ENDED = 'ENDED'
}

export enum DiscountType {
  PERCENTAGE = 'PERCENTAGE',
  FIXED_AMOUNT = 'FIXED_AMOUNT'
}

export enum TargetType {
  ALL = 'ALL',
  CATEGORY = 'CATEGORY',
  PRODUCT = 'PRODUCT'
}

export enum ScheduleType {
  ALWAYS = 'ALWAYS',
  TIME_WINDOW = 'TIME_WINDOW',
  DAY_OF_WEEK = 'DAY_OF_WEEK'
}

export interface ICampaign extends Document {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  name: string;
  offerCode: string;
  description?: string;
  discountType: DiscountType;
  discountValue: number;
  targetType: TargetType;
  targetIds?: Record<string, unknown>;
  scheduleType: ScheduleType;
  scheduleConfig?: Record<string, unknown>;
  redemptionUrl?: string;
  qrCodeImageUrl?: string;
  status: CampaignStatus;
  startsAt?: Date;
  endsAt?: Date;
  platform: Provider;
  platformDiscountId?: string;
  platformDiscountData?: Record<string, unknown>;
  socialId?: mongoose.Types.ObjectId;
  nfcCount: number;
  scanCount: number;
  redemptionCount: number;
  redemptionRevenueCents: number;
  createdAt?: Date;
  updatedAt?: Date;
}

const CampaignSchema = new Schema<ICampaign>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true },
    offerCode: { type: String, required: true, unique: true },
    description: { type: String },
    discountType: {
      type: String,
      enum: Object.values(DiscountType),
      default: DiscountType.PERCENTAGE
    },
    discountValue: { type: Number, default: 0 },
    targetType: {
      type: String,
      enum: Object.values(TargetType),
      default: TargetType.ALL
    },
    targetIds: { type: Schema.Types.Mixed },
    scheduleType: {
      type: String,
      enum: Object.values(ScheduleType),
      default: ScheduleType.ALWAYS
    },
    scheduleConfig: { type: Schema.Types.Mixed },
    redemptionUrl: { type: String },
    qrCodeImageUrl: { type: String },
    status: {
      type: String,
      enum: Object.values(CampaignStatus),
      default: CampaignStatus.DRAFT
    },
    startsAt: { type: Date },
    endsAt: { type: Date },
    platform: { type: String, enum: Object.values(Provider), required: true },
    platformDiscountId: { type: String },
    platformDiscountData: { type: Schema.Types.Mixed },
    socialId: { type: Schema.Types.ObjectId },
    nfcCount: { type: Number, default: 0 },
    scanCount: { type: Number, default: 0 },
    redemptionCount: { type: Number, default: 0 },
    redemptionRevenueCents: { type: Number, default: 0 }
  },
  { timestamps: true, collection: 'campaigns' }
);

CampaignSchema.index({ userId: 1 });
CampaignSchema.index({ status: 1 });
CampaignSchema.index({ platform: 1 });
CampaignSchema.index({ socialId: 1 });

export const Campaign = mongoose.model<ICampaign>('Campaign', CampaignSchema);
