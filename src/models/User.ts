/**
 * User Model - Mongoose schema for User collection
 * Based on Prisma schema provided
 */

import mongoose, { Document, Schema } from 'mongoose';

export interface IUser extends Document {
  _id: mongoose.Types.ObjectId;
  name?: string;
  email?: string;
  emailVerified?: Date;
  image?: string;
  password?: string;
  isTwoFactorEnabled: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

const UserSchema = new Schema<IUser>({
  name: {
    type: String,
    required: false
  },
  email: {
    type: String,
    required: false,
    sparse: true // Allows multiple null values
  },
  emailVerified: {
    type: Date,
    required: false
  },
  image: {
    type: String,
    required: false
  },
  password: {
    type: String,
    required: false
  },
  isTwoFactorEnabled: {
    type: Boolean,
    default: false,
    required: true
  }
}, {
  timestamps: true, // Automatically adds createdAt and updatedAt
  collection: 'users'
});

// Indexes (only define indexes not already set via 'unique: true' in schema)
// Note: email already has unique: true + sparse: true in schema definition
// Note: _id is automatically indexed by MongoDB

export const User = mongoose.model<IUser>('User', UserSchema);

