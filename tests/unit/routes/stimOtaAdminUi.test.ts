import { createStimOtaAdminRoutes } from '@/routes/stimOtaAdminRoutes';
import { STIM_OTA_ADMIN_HTML } from '@/routes/stimOtaAdminUi';
import type { IFirmwareStorage } from '@/services/firmwareStorageService';

describe('stim OTA admin UI', () => {
  const origEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = origEnv;
  });

  it('serves the upload page outside production', () => {
    process.env.NODE_ENV = 'development';
    const router = createStimOtaAdminRoutes({
      storage: {} as IFirmwareStorage,
      redis: null
    });
    const layer = (router.stack as Array<{ route?: { path: string; methods: Record<string, boolean> } }>).find(
      (l) => l.route?.path === '/stim' && l.route.methods.get
    );
    expect(layer).toBeTruthy();
    const res = {
      statusCode: 200,
      status(n: number) {
        this.statusCode = n;
        return this;
      },
      json() {
        return this;
      },
      type() {
        return this;
      },
      send(body: string) {
        this.body = body;
        return this;
      },
      body: ''
    };
    layer!.route!.stack[0].handle({}, res, () => undefined);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(STIM_OTA_ADMIN_HTML);
    expect(res.body).toContain('stim/firmware');
    expect(res.body).not.toContain('Admin JWT');
    expect(res.body).not.toContain('TEST_OTA_SHA256');
    expect(res.body).not.toContain('TEST_OTA_SIGNATURE');
  });
});
