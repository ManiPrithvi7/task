jest.mock('@/models/Device', () => ({
  Device: { findOne: jest.fn() }
}));

jest.mock('@/models/Business', () => ({
  Business: { findById: jest.fn() }
}));

import { Device } from '@/models/Device';
import { Business } from '@/models/Business';
import {
  buildLoyaltyIdleMqttMessage,
  publishLoyaltyIdle,
  publishLoyaltyIdleForDevice,
  resolveBusinessNameForDevice
} from '@/services/publishLoyaltyIdle';

describe('resolveBusinessNameForDevice', () => {
  it('returns Business.name when device has businessId', async () => {
    (Device.findOne as jest.Mock).mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ businessId: 'biz_1' })
      })
    });
    (Business.findById as jest.Mock).mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ name: 'Atlus Coffee Co.' })
      })
    });

    await expect(resolveBusinessNameForDevice('DEVICE-17')).resolves.toBe('Atlus Coffee Co.');
  });

  it('returns null when device or name is missing', async () => {
    (Device.findOne as jest.Mock).mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(null)
      })
    });
    await expect(resolveBusinessNameForDevice('DEVICE-17')).resolves.toBeNull();
  });
});

describe('buildLoyaltyIdleMqttMessage', () => {
  it('returns enveloped loyalty-idle JSON', () => {
    const raw = buildLoyaltyIdleMqttMessage('Atlus Coffee Co.', new Date('2026-05-15T10:35:00.000Z'));
    expect(JSON.parse(raw)).toEqual({
      version: '1.2',
      screen: 'loyalty',
      celebration: 'false',
      muted: 'false',
      timestamp: '2026-05-15T10:35:00.000Z',
      payload: { type: 'loyalty-idle', businessName: 'Atlus Coffee Co.' }
    });
  });
});

describe('publishLoyaltyIdle', () => {
  it('publishes retained message on /loyalty', async () => {
    const publish = jest.fn().mockResolvedValue(undefined);
    const mqtt = { publish, isConnected: () => true };

    await publishLoyaltyIdle(mqtt, 'proof.mqtt', 'DEVICE-17', 'Atlus Coffee Co.');

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: 'proof.mqtt/DEVICE-17/loyalty',
        qos: 1,
        retain: true
      })
    );
    const envelope = JSON.parse(publish.mock.calls[0][0].payload);
    expect(envelope.payload.businessName).toBe('Atlus Coffee Co.');
  });

  it('skips publish when businessName is empty', async () => {
    const publish = jest.fn();
    const mqtt = { publish, isConnected: () => true };
    await publishLoyaltyIdle(mqtt, 'proof.mqtt', 'DEVICE-17', '   ');
    expect(publish).not.toHaveBeenCalled();
  });
});

describe('publishLoyaltyIdleForDevice', () => {
  it('resolves name and publishes', async () => {
    (Device.findOne as jest.Mock).mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ businessId: 'biz_1' })
      })
    });
    (Business.findById as jest.Mock).mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ name: 'Atlus Coffee Co.' })
      })
    });
    const publish = jest.fn().mockResolvedValue(undefined);
    const mqtt = { publish, isConnected: () => true };

    await publishLoyaltyIdleForDevice(mqtt, 'proof.mqtt', 'DEVICE-17');

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'proof.mqtt/DEVICE-17/loyalty', retain: true })
    );
  });
});
