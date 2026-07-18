import { publishGmbScreen } from '../../../src/webhooks/delivery/publishGmbScreen';

const mockPublish = jest.fn().mockResolvedValue(undefined);

const mqttClient = {
  publish: mockPublish
} as unknown as Parameters<typeof publishGmbScreen>[0];

describe('publishGmbScreen payload shapes', () => {
  beforeEach(() => {
    mockPublish.mockClear();
  });

  async function parsePayload(verifiedReview: number) {
    const result = await publishGmbScreen(
      mqttClient,
      'proof.mqtt',
      'DEVICE-1',
      { verifiedReview, rating: 4.5, qrText: 'https://g.page/r/test' },
      true
    );
    return JSON.parse(result.payload);
  }

  it('normal state', async () => {
    const envelope = await parsePayload(42);
    expect(envelope).toMatchObject({
      version: '1.2',
      screen: 'gmb',
      muted: 'false',
      celebration: 'false'
    });
    expect(envelope.payload).toMatchObject({
      verifiedReview: 42,
      nextGoal: 45,
      remainingGoal: 3,
      rating: 4.5
    });
    expect(envelope.payload).not.toHaveProperty('celebration_type');
  });

  it('mini celebration every 5', async () => {
    const envelope = await parsePayload(15);
    expect(envelope.celebration).toBe('true');
    expect(envelope.payload).toMatchObject({
      celebration_type: 'mini',
      verifiedReview: 15,
      nextGoal: 15,
      remainingGoal: 0,
      progress: 100
    });
  });

  it('mega celebration every 25', async () => {
    const envelope = await parsePayload(25);
    expect(envelope.celebration).toBe('true');
    expect(envelope.payload).toMatchObject({
      celebration_type: 'mega',
      verifiedReview: 25,
      nextGoal: 25,
      remainingGoal: 0,
      progress: 100
    });
  });
});
