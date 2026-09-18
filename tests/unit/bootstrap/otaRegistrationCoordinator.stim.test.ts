import { deliverOtaOnRegistration } from '@/bootstrap/otaRegistrationCoordinator';
import type { AppConfig } from '@/config';
import type { OtaService } from '@/services/otaService';

describe('deliverOtaOnRegistration stim skip', () => {
  const origEnv = process.env;

  beforeEach(() => {
    process.env = { ...origEnv };
    process.env.STIMULATE_DEVICE = 'DEVICE-19';
    process.env.TEST_OTA_URL = 'https://cdn.example.com/firmware.bin';
  });

  afterEach(() => {
    process.env = origEnv;
  });

  it('does not call otaService for allowlisted device when TEST_OTA_URL is set', async () => {
    const otaService = {
      deliverPendingToDevice: jest.fn(),
      resolveUpdate: jest.fn()
    };
    await deliverOtaOnRegistration(
      {
        config: { ota: { enabled: true } } as AppConfig,
        otaService: otaService as unknown as OtaService
      },
      'DEVICE-19',
      '1.0.0'
    );
    expect(otaService.deliverPendingToDevice).not.toHaveBeenCalled();
    expect(otaService.resolveUpdate).not.toHaveBeenCalled();
  });
});
