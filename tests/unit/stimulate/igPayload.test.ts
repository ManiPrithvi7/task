/**
 * TEMP STIMULATE — remove after testing
 * Ensures stim IG MQTT matches production envelope types (device decoder).
 */
import { buildStimIgPayload } from '../../../stimulate/igRunner';
import { formatInstagramScreenMqttPayload } from '../../../src/services/instagramService';

describe('buildStimIgPayload matches production IG schema', () => {
  it('uses boolean muted/celebration and achievement (not string flags / nextGoal)', () => {
    const stim = JSON.parse(buildStimIgPayload('DEVICE-15', 1, 'proof.mqtt').payload);
    const prod = JSON.parse(
      formatInstagramScreenMqttPayload(
        {
          deviceId: 'DEVICE-15',
          success: true,
          fetched_at: stim.timestamp,
          data: { followers_count: 1, instagram_username: '' }
        },
        'proof.mqtt'
      ).payload
    );

    expect(Object.keys(stim).sort()).toEqual(Object.keys(prod).sort());
    expect(typeof stim.muted).toBe('boolean');
    expect(typeof stim.celebration).toBe('boolean');
    expect(stim.celebration).toBe(false);
    expect(stim.muted).toBe(true);
    expect(stim.payload).toEqual(prod.payload);
    expect(stim.payload.achievement).toBe(25);
    expect(stim.payload).not.toHaveProperty('nextGoal');
  });

  it('celebrates every 25 with boolean unmute', () => {
    const stim = JSON.parse(buildStimIgPayload('DEVICE-15', 25, 'proof.mqtt').payload);
    expect(stim.muted).toBe(false);
    expect(stim.celebration).toBe(true);
    expect(stim.payload.achievement).toBe(50);
    expect(stim.payload.followers).toBe(25);
  });
});
