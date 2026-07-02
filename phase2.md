🚀 PHASE 2: RUNTIME MODERNIZATION & CODE QUALITY
Context
Runtime target: Bun (primary), Node.js fallback
Deployment: Railway (remove all Render configs)
Current branch: production_v2
Phase 1 status: Complete — security fixes verified, private keys removed, git clean
P2.1: BUN RUNTIME MIGRATION
1. Update package.json
Replace the entire scripts and engines sections:
JSON
{
  "name": "mqtt-publisher-lite",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "bun --watch src/index.ts",
    "build": "bun build ./src/index.ts --outdir ./dist --target bun",
    "start": "bun run ./dist/index.js",
    "test": "bun test",
    "test:unit": "bun test tests/unit",
    "test:connections": "bun test tests/integration/connections.ts",
    "lint": "eslint src/ tests/ --ext .ts",
    "lint:fix": "eslint src/ tests/ --ext .ts --fix",
    "format": "prettier --write \"src/**/*.ts\" \"tests/**/*.ts\"",
    "coverage": "bun test --coverage",
    "typecheck": "tsc --noEmit"
  },
  "engines": {
    "bun": ">=1.1.0"
  }
}
Remove from dependencies: Anything Node-specific that's Bun-incompatible (check package.json for ts-node, ts-node-dev, nodemon — remove these).
Add to devDependencies:
JSON
"@typescript-eslint/eslint-plugin": "^7.0.0",
"@typescript-eslint/parser": "^7.0.0",
"eslint": "^8.57.0",
"prettier": "^3.2.0"
2. Update Dockerfile
Replace entirely:
dockerfile
# Build stage
FROM oven/bun:1.1-alpine AS builder

WORKDIR /app
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

# Production stage
FROM oven/bun:1.1-alpine

RUN addgroup -g 1001 -S bunjs && adduser -S bunjs -u 1001
WORKDIR /app

COPY --from=builder --chown=bunjs:bunjs /app/dist ./dist
COPY --from=builder --chown=bunjs:bunjs /app/node_modules ./node_modules
COPY --from=builder --chown=bunjs:bunjs /app/package.json ./

USER bunjs

ENV NODE_ENV=production
ENV PORT=3002

EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:3002/health').then(r => r.ok ? process.exit(0) : process.exit(1))"

CMD ["bun", "run", "./dist/index.js"]
3. Create .dockerignore
dockerfile
node_modules
.git
.gitignore
README.md
.env
.env.*
coverage
dist
tests
docs
*.md
*.key
*.pem
*.p12
*.pfx
data/
4. Clean up Node artifacts
bash
rm -f package-lock.json
bun install  # generates bun.lockb
5. Update tsconfig.json
Ensure these settings for Bun compatibility:
JSON
{
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "bundler",
    "target": "ES2022",
    "types": ["bun-types"]
  }
}
P2.2: REMOVE RENDER CONFIGURATIONS
bash
# Delete Render config
rm -f render.yaml

# Remove Render-specific env vars from .env.example if present
# (grep for REDIS_HOST, REDIS_PORT, REDIS_PASSWORD and remove)
Update any docs/README that mention Render — change to Railway.
P2.3: ESLINT + PRETTIER
1. Create .eslintrc.json
JSON
{
  "root": true,
  "parser": "@typescript-eslint/parser",
  "plugins": ["@typescript-eslint"],
  "extends": [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:@typescript-eslint/recommended-requiring-type-checking"
  ],
  "parserOptions": {
    "project": "./tsconfig.json"
  },
  "rules": {
    "@typescript-eslint/no-explicit-any": "warn",
    "@typescript-eslint/no-floating-promises": "error",
    "@typescript-eslint/await-thenable": "error",
    "no-console": "warn"
  }
}
2. Create .prettierrc
JSON
{
  "semi": true,
  "singleQuote": true,
  "tabWidth": 2,
  "trailingComma": "es5",
  "printWidth": 100
}
3. Create .eslintignore
plain
dist/
node_modules/
coverage/
data/
P2.4: CORRELATION ID MIDDLEWARE
Create src/middleware/correlationId.ts
TypeScript
import { v4 as uuidv4 } from 'uuid';
import { Request, Response, NextFunction } from 'express';

export function correlationIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const id = req.get('x-correlation-id') || uuidv4();
  (req as any).correlationId = id;
  res.setHeader('x-correlation-id', id);
  next();
}
Wire into src/servers/httpServer.ts
Add near the top of middleware stack (before routes):
TypeScript
import { correlationIdMiddleware } from '../middleware/correlationId';
// ...
this.app.use(correlationIdMiddleware);
P2.5: PROMETHEUS METRICS
Create src/middleware/metrics.ts
TypeScript
import { Request, Response } from 'express';
import client from 'prom-client';

const register = new client.Registry();

// Add default metrics
client.collectDefaultMetrics({ register });

// Custom metrics
const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status'],
  registers: [register]
});

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration',
  labelNames: ['method', 'route'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [register]
});

const mqttMessagesReceived = new client.Counter({
  name: 'mqtt_messages_received_total',
  help: 'Total MQTT messages received',
  labelNames: ['topic_pattern'],
  registers: [register]
});

const mqttConnectedDevices = new client.Gauge({
  name: 'mqtt_connected_devices',
  help: 'Number of connected MQTT devices',
  registers: [register]
});

export function metricsMiddleware(req: Request, res: Response, next: () => void) {
  const end = httpRequestDuration.startTimer();
  
  res.on('finish', () => {
    httpRequestsTotal.inc({
      method: req.method,
      route: req.route?.path || req.path,
      status: res.statusCode.toString()
    });
    end({ method: req.method, route: req.route?.path || req.path });
  });
  
  next();
}

export function getMetricsHandler() {
  return async (req: Request, res: Response) => {
    res.setHeader('Content-Type', register.contentType);
    res.send(await register.metrics());
  };
}

export { mqttMessagesReceived, mqttConnectedDevices };
Wire into src/servers/httpServer.ts
TypeScript
import { metricsMiddleware, getMetricsHandler } from '../middleware/metrics';
// ...
this.app.use(metricsMiddleware);
this.app.get('/metrics', getMetricsHandler()); // internal only, add auth if needed
P2.6: INFLUXDB AS REQUIRED DEPENDENCY
Update src/config/index.ts or startup logic:
TypeScript
// In app startup, fail fast if InfluxDB is configured but unreachable
if (config.influxdb.enabled && !config.influxdb.url) {
  throw new Error('INFLUXDB_URL is required when metrics collection is enabled');
}
Add to .env.example:
bash
# InfluxDB (REQUIRED for device transaction logging)
INFLUXDB_URL=http://localhost:8086
INFLUXDB_TOKEN=required
INFLUXDB_ORG=withproof
INFLUXDB_BUCKET=devices
INFLUXDB_RETENTION_DAYS=30
P2.7: CI/CD PIPELINE
Create .github/workflows/ci.yml
yaml
name: CI

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - uses: oven-sh/setup-bun@v1
        with:
          bun-version: latest
          
      - run: bun install --frozen-lockfile
      - run: bun run lint
      - run: bun run typecheck
      - run: bun run build
      - run: bun test
      
      - name: Upload coverage
        uses: codecov/codecov-action@v4
        if: always()
Create railway.json
JSON
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "DOCKERFILE",
    "dockerfilePath": "Dockerfile"
  },
  "deploy": {
    "startCommand": "bun run ./dist/index.js",
    "healthcheckPath": "/health",
    "healthcheckTimeout": 30,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 3
  }
}
P2.8: PRE-COMMIT HOOKS
bash
bun add -d husky
bunx husky init
Create .husky/pre-commit:
bash
#!/bin/sh
. "$(dirname "$0")/_/husky.sh"

# Block private keys
if git diff --cached --name-only | grep -qE '\.(key|p12|pfx)$'; then
  echo "ERROR: Private key files detected. Use env injection."
  exit 1
fi

bun run build
bun run test:unit
bun run lint
📋 EXECUTION ORDER FOR CODEX
Work in this exact order. Do not skip steps. Show raw output for each verification.
Table
Step	Task	Verification
1	Update package.json	cat package.json | grep -A5 '"scripts"'
2	Update Dockerfile	head -20 Dockerfile
3	Create .dockerignore	cat .dockerignore
4	Remove package-lock.json, run bun install	ls bun.lockb && ls package-lock.json 2>|echo "gone"
5	Update tsconfig.json	cat tsconfig.json | grep -E '"module"|"moduleResolution"|"types"'
6	Delete render.yaml	ls render.yaml 2>|echo "gone"
7	Create ESLint/Prettier configs	cat .eslintrc.json && cat .prettierrc
8	Create correlation ID middleware	cat src/middleware/correlationId.ts
9	Wire correlation ID into httpServer	grep -n "correlationId" src/servers/httpServer.ts
10	Create metrics middleware	cat src/middleware/metrics.ts | head -30
11	Wire metrics into httpServer	grep -n "metrics" src/servers/httpServer.ts
12	Update InfluxDB config	grep -n "INFLUXDB" .env.example
13	Create GitHub Actions CI	cat .github/workflows/ci.yml
14	Create railway.json	cat railway.json
15	Setup husky pre-commit	cat .husky/pre-commit
16	Final verification	bun run build && bun run lint
17	Git commit	git add -A && git commit -m "chore: Bun migration, ESLint, metrics, CI/CD"
18	Proof	git log --oneline -3 && git status --short
🚨 Rules for This Phase
Show raw output for every verification step
Do not claim success until bun run build passes and bun run lint passes
If bun run build fails, fix errors before proceeding
If bun run lint fails, fix errors or adjust rules in .eslintrc.json
Commit only after all verifications pass
No options, no framing — execute the steps in order