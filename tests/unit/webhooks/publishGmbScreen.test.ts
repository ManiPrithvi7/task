import {
  buildGmbScreenPayload,
  buildScreenEnvelope
} from '../../../src/services/screenEnvelope';

/** Same envelope path as publishGmbScreen — avoids jest.mock leakage from other test files. */
function buildGmbPublishEnvelope(verifiedReview: number) {
  const { payload: screenPayload, envelopeOpts } = buildGmbScreenPayload({
    verifiedReview,
    rating: 4.5,
    qrText: 'https://g.page/r/test',
    reviews: []
  });
  return buildScreenEnvelope('gmb', screenPayload, envelopeOpts);
}

describe('publishGmbScreen payload shapes', () => {
  it('normal state', () => {
    const envelope = buildGmbPublishEnvelope(42);
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

  it('mini celebration every 5', () => {
    const envelope = buildGmbPublishEnvelope(15);
    expect(envelope.celebration).toBe('true');
    expect(envelope.payload).toMatchObject({
      celebration_type: 'mini',
      verifiedReview: 15,
      nextGoal: 15,
      remainingGoal: 0,
      progress: 100
    });
  });

  it('mega celebration every 10', () => {
    const envelope = buildGmbPublishEnvelope(20);
    expect(envelope.celebration).toBe('true');
    expect(envelope.payload).toMatchObject({
      celebration_type: 'mega',
      verifiedReview: 20,
      nextGoal: 20,
      remainingGoal: 0,
      progress: 100
    });
  });
});
