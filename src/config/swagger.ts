import { Express } from 'express';
import { join, sep } from 'path';
import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import packageJson from '../../package.json';

function resolveApiGlobs(): string[] {
  const isCompiled = __filename.includes(`${sep}dist${sep}`);
  const base = join(__dirname, '..');
  const ext = isCompiled ? 'js' : 'ts';
  return [
    join(base, 'config', `swaggerSchemas.${ext}`),
    join(base, 'servers', `httpServer.${ext}`),
    join(base, 'routes', `*.${ext}`)
  ];
}

const swaggerDefinition = {
  openapi: '3.0.3',
  info: {
    title: 'StatsMQTT Lite API',
    version: packageJson.version,
    description:
      'HTTP API for device provisioning, webhooks, and broker integration. ' +
      'WebSocket traffic uses `/ws` (not covered by this spec). ' +
      'See README.md for firmware integration examples.'
  },
  servers: [{ url: '/' }]
};

let cachedSpec: Record<string, unknown> | null = null;

export function getSwaggerSpec(): Record<string, unknown> {
  if (!cachedSpec) {
    cachedSpec = swaggerJsdoc({
      definition: swaggerDefinition,
      apis: resolveApiGlobs()
    }) as Record<string, unknown>;
  }
  return cachedSpec;
}

/** Clear cached spec (for tests). */
export function resetSwaggerSpecCache(): void {
  cachedSpec = null;
}

export function setupSwaggerUi(app: Express): void {
  app.get('/api/docs/openapi.json', (_req, res) => {
    res.json(getSwaggerSpec());
  });

  app.use(
    '/api/docs',
    swaggerUi.serve,
    swaggerUi.setup(getSwaggerSpec(), {
      customSiteTitle: 'StatsMQTT Lite API'
    })
  );
}
