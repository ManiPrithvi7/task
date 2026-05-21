import mongoose, { Document, Schema } from 'mongoose';

export interface IShopifyProfile extends Document {
  _id: mongoose.Types.ObjectId;
  socialId: mongoose.Types.ObjectId;
  shopDomain: string;
  shopName?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const ShopifyProfileSchema = new Schema<IShopifyProfile>(
  {
    socialId: { type: Schema.Types.ObjectId, required: true, unique: true },
    shopDomain: { type: String, required: true, unique: true }
  },
  { timestamps: true, collection: 'ShopifyProfile' }
);

export const ShopifyProfile = mongoose.model<IShopifyProfile>(
  'ShopifyProfile',
  ShopifyProfileSchema
);
