import { getSwaggerSpec, resetSwaggerSpecCache } from '@/config/swagger';

describe('swagger', () => {
  beforeEach(() => {
    resetSwaggerSpecCache();
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
    expect(paths['/api/v1/connections/validate']).toBeDefined();
    expect(paths['/api/pos-promotions/webhooks/shopify']).toBeDefined();
  });

  it('documents at least 21 paths', () => {
    const paths = getSwaggerSpec().paths as Record<string, unknown>;
    expect(Object.keys(paths).length).toBeGreaterThanOrEqual(21);
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
