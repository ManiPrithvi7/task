import mongoose, { Document, Schema } from 'mongoose';

export interface IDeviceTransactionLog extends Document {
  _id: mongoose.Types.ObjectId;
  deviceId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  eventType: string;
  loggedAt: Date;
  metadata?: Record<string, unknown>;
}

const DeviceTransactionLogSchema = new Schema<IDeviceTransactionLog>(
  {
    deviceId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: Schema.Types.ObjectId, required: true },
    eventType: { type: String, required: true },
    loggedAt: { type: Date, default: Date.now },
    metadata: { type: Schema.Types.Mixed }
  },
  { timestamps: false, collection: 'DeviceTransactionLog' }
);

DeviceTransactionLogSchema.index({ deviceId: 1, loggedAt: 1 });

export const DeviceTransactionLog = mongoose.model<IDeviceTransactionLog>(
  'DeviceTransactionLog',
  DeviceTransactionLogSchema
);
