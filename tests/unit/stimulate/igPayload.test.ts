/**
 * TEMP STIMULATE — remove after testing
 * Ensures stim IG MQTT matches production envelope schema.
 */
import { buildStimIgPayload } from '../../../stimulate/igRunner';
import { formatInstagramScreenMqttPayload } from '../../../src/services/instagramService';

describe('buildStimIgPayload matches production IG schema', () => {
  it('uses string muted/celebration and achievement (not nextGoal)', () => {
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
    expect(typeof stim.muted).toBe('string');
    expect(typeof stim.celebration).toBe('string');
    expect(stim.celebration).toBe('false');
    expect(stim.muted).toBe('true');
    expect(stim.payload).toEqual(prod.payload);
    expect(stim.payload.achievement).toBe(25);
    expect(stim.payload).not.toHaveProperty('nextGoal');
    expect(stim.payload).not.toHaveProperty('celebration_type');
  });

  it('mini celebration every 25 keeps muted true', () => {
    const stim = JSON.parse(buildStimIgPayload('DEVICE-15', 50, 'proof.mqtt').payload);
    expect(stim.muted).toBe('true');
    expect(stim.celebration).toBe('true');
    expect(stim.payload.celebration_type).toBe('mini');
    expect(stim.payload.achievement).toBe(50);
    expect(stim.payload.followers).toBe(50);
    expect(stim.payload.progress).toBe(100);
  });

  it('mega celebration every 100', () => {
    const stim = JSON.parse(buildStimIgPayload('DEVICE-15', 100, 'proof.mqtt').payload);
    expect(stim.celebration).toBe('true');
    expect(stim.payload.celebration_type).toBe('mega');
    expect(stim.payload.achievement).toBe(100);
  });
});
