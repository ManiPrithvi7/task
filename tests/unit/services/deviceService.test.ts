/**
 * deviceService — P0 Test Suite
 *
 * P0: ActiveDeviceCache end-to-end file roundtrip
 * P0: registerDevice update vs create paths (+ macID mismatch pin)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mockDeviceFindOne = jest.fn();
const mockDeviceSave = jest.fn();

jest.mock('@/models/Device', () => {
  const DeviceModel = jest.fn().mockImplementation((doc: Record<string, unknown>) => ({
    ...doc,
    save: mockDeviceSave,
  }));
  (DeviceModel as unknown as { findOne: jest.Mock }).findOne = mockDeviceFindOne;
  return {
    Device: DeviceModel,
    DeviceStatus: {
      UNALLOCATED: 'UNALLOCATED',
      ACTIVE: 'ACTIVE',
      OFFLINE: 'OFFLINE',
    },
  };
});

jest.mock('@/models/DeviceOtaState', () => ({
  DeviceOtaState: {
    updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
  },
}));


import { Device, DeviceStatus } from '@/models/Device';
import { ActiveDeviceCache, DeviceService, type DeviceData } from '@/services/deviceService';

const baseDeviceData: DeviceData = {
  deviceId: 'client-abc',
  username: 'unassigned',
  status: 'active',
  clientId: 'client-abc',
  macID: 'AA:BB:CC:DD:EE:FF',
};

describe('ActiveDeviceCache', () => {
  let tmpDir: string;
  let cache: ActiveDeviceCache;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'active-device-cache-'));
    cache = new ActiveDeviceCache(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists set → get → getAll → count → updateLastSeen → remove → flush roundtrip', async () => {
    const device = {
      deviceId: 'dev-1',
      businessId: '507f1f77bcf86cd799439011',
      lastSeen: 1_700_000_000_000,
      instagramAccountId: 'ig-123',
      accessToken: 'token-abc',
    };

    expect(await cache.setActive(device)).toBe(true);
    expect(await cache.getActive('dev-1')).toEqual(device);

    const all = await cache.getAllActive();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(device);
    expect(await cache.count()).toBe(1);

    await cache.updateLastSeen('dev-1');
    const updated = await cache.getActive('dev-1');
    expect(updated).not.toBeNull();
    expect(updated!.lastSeen).toBeGreaterThan(device.lastSeen);

    expect(await cache.removeActive('dev-1')).toBe(true);
    expect(await cache.getActive('dev-1')).toBeNull();
    expect(await cache.count()).toBe(0);

    // Re-add and flush
    await cache.setActive({ ...device, lastSeen: 1_700_000_000_001 });
    expect(await cache.flushAll()).toBe(1);
    expect(await cache.getAllActive()).toEqual([]);

    // File exists on disk under temp DATA_DIR
    const storePath = path.join(tmpDir, 'active-devices.json');
    expect(fs.existsSync(storePath)).toBe(true);
  });

  it('getActive returns null for unknown deviceId', async () => {
    expect(await cache.getActive('missing')).toBeNull();
  });
});

describe('DeviceService.registerDevice', () => {
  let service: DeviceService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new DeviceService(3600);
    mockDeviceSave.mockImplementation(function (this: { clientId?: string }) {
      return Promise.resolve(this);
    });
  });

  afterEach(async () => {
    await service.close();
  });

  it('updates existing device when clientId and macID match', async () => {
    const existing = {
      clientId: 'client-abc',
      macID: 'AA:BB:CC:DD:EE:FF',
      status: DeviceStatus.OFFLINE,
      save: jest.fn().mockImplementation(function (this: typeof existing) {
        return Promise.resolve(this);
      }),
    };
    mockDeviceFindOne.mockResolvedValue(existing);

    const result = await service.registerDevice({
      ...baseDeviceData,
      metadata: { appVersion: ' 2.1.0 ' },
    });

    expect(mockDeviceFindOne).toHaveBeenCalledWith({ clientId: 'client-abc' });
    expect(existing.status).toBe(DeviceStatus.ACTIVE);
    expect(existing.save).toHaveBeenCalled();
    expect(result).toBe(existing);
    expect(Device).not.toHaveBeenCalled();
  });

  it('creates new device when no existing record is found', async () => {
    mockDeviceFindOne.mockResolvedValue(null);
    mockDeviceSave.mockResolvedValue({ clientId: 'client-abc' });

    await service.registerDevice(baseDeviceData);

    expect(Device).toHaveBeenCalledWith(
      expect.objectContaining({
        macID: 'AA:BB:CC:DD:EE:FF',
        clientId: 'client-abc',
        status: DeviceStatus.ACTIVE,
        tokenUsed: false,
        businessId: undefined,
        crt: undefined,
        ca_certificate: undefined,
      })
    );
    expect(mockDeviceSave).toHaveBeenCalled();
  });

  it('creates new device when existing clientId has different macID (identity bug pin)', async () => {
    const existing = {
      clientId: 'client-abc',
      macID: '11:22:33:44:55:66',
      status: DeviceStatus.ACTIVE,
      save: jest.fn(),
    };
    mockDeviceFindOne.mockResolvedValue(existing);
    mockDeviceSave.mockResolvedValue({ clientId: 'client-abc' });

    await service.registerDevice(baseDeviceData);

    expect(Device).toHaveBeenCalled();
    expect(existing.save).not.toHaveBeenCalled();
    expect(mockDeviceSave).toHaveBeenCalled();
  });

  it('sets UNALLOCATED status on create when data.status is inactive', async () => {
    mockDeviceFindOne.mockResolvedValue(null);
    mockDeviceSave.mockResolvedValue({});

    await service.registerDevice({ ...baseDeviceData, status: 'inactive' });

    expect(Device).toHaveBeenCalledWith(
      expect.objectContaining({ status: DeviceStatus.UNALLOCATED })
    );
  });
});
