import { resolveMqttFullTopic } from '@/servers/mqttClient';

describe('resolveMqttFullTopic', () => {
  it('prepends MQTT_TOPIC_PREFIX when set, including loyalty topics under topicRoot', () => {
    expect(resolveMqttFullTopic('prefix', 'proof.mqtt/DEVICE-17/loyalty')).toBe(
      'prefix/proof.mqtt/DEVICE-17/loyalty'
    );
    expect(resolveMqttFullTopic('prefix', 'proof.mqtt/+/ack')).toBe('prefix/proof.mqtt/+/ack');
  });

  it('leaves topic unchanged when MQTT_TOPIC_PREFIX is empty (prod default)', () => {
    expect(resolveMqttFullTopic('', 'proof.mqtt/DEVICE-17/loyalty')).toBe(
      'proof.mqtt/DEVICE-17/loyalty'
    );
    expect(resolveMqttFullTopic(undefined, 'proof.mqtt/DEVICE-17/ack')).toBe(
      'proof.mqtt/DEVICE-17/ack'
    );
    expect(resolveMqttFullTopic('', 'foo/bar')).toBe('foo/bar');
  });
});
