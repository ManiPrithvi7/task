import mongoose, { Document, Schema } from 'mongoose';

export interface ISquareProfile extends Document {
  _id: mongoose.Types.ObjectId;
  socialId: mongoose.Types.ObjectId;
  merchantId: string;
  merchantName?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const SquareProfileSchema = new Schema<ISquareProfile>(
  {
    socialId: { type: Schema.Types.ObjectId, required: true, unique: true },
    merchantId: { type: String, required: true, unique: true }
  },
  { timestamps: true, collection: 'SquareProfile' }
);

export const SquareProfile = mongoose.model<ISquareProfile>(
  'SquareProfile',
  SquareProfileSchema
);
