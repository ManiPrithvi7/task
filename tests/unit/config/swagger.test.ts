import { getSwaggerSpec, resetSwaggerSpecCache, setupSwaggerUi } from '@/config/swagger';

describe('swagger', () => {
  beforeEach(() => {
    resetSwaggerSpecCache();
  });

  it('skips UI unless SWAGGER_ENABLED=true', () => {
    const prev = process.env.SWAGGER_ENABLED;
    delete process.env.SWAGGER_ENABLED;
    const use = jest.fn();
    const get = jest.fn();
    setupSwaggerUi({ use, get } as never);
    expect(use).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    if (prev === undefined) delete process.env.SWAGGER_ENABLED;
    else process.env.SWAGGER_ENABLED = prev;
  });

  it('generates OpenAPI spec without error', () => {
    const spec = getSwaggerSpec();
    expect(spec.openapi).toBe('3.0.3');
    expect(spec.info).toBeDefined();
    expect(spec.paths).toBeDefined();
  });

  it('includes key documented routes', () => {
    const paths = getSwaggerSpec().paths as Record<string, unknown>;
    expect(paths['/health']).toBeDefined();
    expect(paths['/api/v1/onboarding']).toBeDefined();
    expect(paths['/api/v1/mqtt-config']).toBeDefined();
    expect(paths['/api/webhooks/google-business-reviews']).toBeDefined();
    expect(paths['/api/v1/influx/query']).toBeDefined();
    expect(paths['/api/v1/integrations/connect']).toBeDefined();
    expect(paths['/api/v1/dashboard/device/{deviceId}/baseline']).toBeDefined();
    expect(paths['/api/v1/dashboard/instagram/{deviceId}/summary']).toBeDefined();
    expect(paths['/loyalty/join']).toBeDefined();
  });

  it('documents at least 15 paths', () => {
    const paths = getSwaggerSpec().paths as Record<string, unknown>;
    expect(Object.keys(paths).length).toBeGreaterThanOrEqual(15);
  });

  it('defines required security schemes', () => {
    const components = getSwaggerSpec().components as {
      securitySchemes?: Record<string, unknown>;
    };
    expect(components.securitySchemes?.BearerAuth).toBeDefined();
    expect(components.securitySchemes?.ApiKeyAuth).toBeDefined();
    expect(components.securitySchemes?.MtlsClientCert).toBeDefined();
  });

  it('excludes OTA HTTP routes from OpenAPI (OTA uses webhook/MQTT)', () => {
    const paths = getSwaggerSpec().paths as Record<string, unknown>;
    const otaPaths = Object.keys(paths).filter((p) => p.includes('/ota'));
    expect(otaPaths).toEqual([]);
  });
});
