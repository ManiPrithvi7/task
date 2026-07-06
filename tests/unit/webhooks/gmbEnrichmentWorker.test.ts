import { publishGmbScreen } from '@/webhooks/delivery/publishGmbScreen';

jest.mock('@/webhooks/delivery/publishGmbScreen', () => ({
  publishGmbScreen: jest.fn().mockResolvedValue({
    topic: 'proof.mqtt/dev1/gmb',
    published: true,
    payload: '{}',
    success: true
  })
}));

jest.mock('@/services/googleBusiness/googleBusinessOAuth', () => ({
  getValidOAuth2Client: jest.fn().mockResolvedValue({})
}));

jest.mock('@/webhooks/gmb/gmbReviewResolve', () => ({
  resolveGmbReviewPayload: jest.fn().mockResolvedValue({
    reviewId: 'r1',
    starRating: 5,
    comment: 'Great',
    reviewerName: 'User',
    updateTime: new Date(),
    createTime: new Date()
  }),
  mapReviewPayloadToStorage: jest.fn((p: { reviewId: string }) => p)
}));

jest.mock('@/models/GoogleBusinessReview', () => ({
  GoogleBusinessReview: { findOneAndUpdate: jest.fn().mockResolvedValue({}) }
}));

jest.mock('@/models/GoogleBusinessLocation', () => ({
  GoogleBusinessLocation: {
    findById: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue({ totalReviewCount: 3 })
    })
  }
}));

jest.mock('@/webhooks/resolve/resolveDevices', () => ({
  resolveDevicesForUser: jest.fn().mockResolvedValue([{ clientId: 'dev1', deviceObjectId: '507f1f77bcf86cd799439011' }])
}));

import { scheduleGmbEnrichment } from '@/webhooks/gmbEnrichmentWorker';

describe('gmbEnrichmentWorker audit context', () => {
  it('passes audit context to publishGmbScreen', async () => {
    const mqttClient = {} as Parameters<typeof scheduleGmbEnrichment>[1]['mqttClient'];
    scheduleGmbEnrichment(
      { account: 'a', location: 'l', review: 'r1', eventType: 'NEW_REVIEW' },
      {
        userId: '507f1f77bcf86cd799439012',
        locationObjectId: '507f1f77bcf86cd799439013',
        account: 'a',
        location: 'l',
        mqttClient,
        topicRoot: 'proof.mqtt',
        webhookConfig: { gmbFastPathOnly: false, deviceTarget: 'primary', mqttPublishEnabled: true } as never
      }
    );

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 50));

    expect(publishGmbScreen).toHaveBeenCalledWith(
      mqttClient,
      'proof.mqtt',
      'dev1',
      expect.objectContaining({ reviewId: 'r1' }),
      true,
      { userId: '507f1f77bcf86cd799439012', deviceId: 'dev1' }
    );
  });
});
