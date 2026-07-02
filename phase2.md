# 🚀 REVISED PHASE 2: RUNTIME MODERNIZATION & CODE QUALITY

## Rules
1. Execute steps **in order**. Do not skip.
2. Show **raw output** for every verification.
3. If a step fails, **stop and report**. Do not proceed.
4. Do not claim "done" until verification passes.
5. No options, no framing.

---

## PHASE 2A: FOUNDATION (Blockers If Wrong)

### 2A.1: Add Missing devDependencies
```bash
$ bun add -d typescript bun-types prom-client @types/express @types/compression @types/cors @types/node
```
**Verify:** `cat package.json | grep -E "typescript|bun-types|prom-client"` — must show all three.

### 2A.2: Check Lockfile Name
```bash
$ ls bun.lock bun.lockb 2>/dev/null
```
**Use whichever exists** in Dockerfile (step 2A.6).

### 2A.3: Create bunfig.toml
```toml
[install]
exact = true

[test]
preload = ["./tests/setup.ts"]

[run]
bun = true
```
If tests use `@/` imports, add `[import]` section with path aliases.

### 2A.4: Test Migration (CRITICAL)
```bash
$ bun test tests/unit 2>&1 | tail -20
```
- If **PASS**: proceed with Bun test.
- If **jest.fn() errors**: create `tests/setup.ts` with `globalThis.jest = jest`.
- If **still failing**: keep Jest temporarily, document in `package.json`.

### 2A.5: tsconfig.json
Only update `types` array:
```json
"types": ["node", "bun-types"]
```
Keep `"module": "CommonJS"` for typecheck. Bun handles build separately.

**Verify:** `bun run typecheck` — must pass (or document pre-existing errors).

### 2A.6: Fix Dockerfile
```dockerfile
FROM oven/bun:1.1-alpine AS builder
WORKDIR /app
COPY package.json bun.lock ./  # Use lockfile from 2A.2
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.1-alpine
RUN apk add --no-cache dumb-init
RUN addgroup -g 1001 -S bunjs && adduser -S bunjs -u 1001
WORKDIR /app
COPY --from=builder --chown=bunjs:bunjs /app/dist ./dist
COPY --from=builder --chown=bunjs:bunjs /app/node_modules ./node_modules
COPY --from=builder --chown=bunjs:bunjs /app/package.json ./
USER bunjs
ENV NODE_ENV=production PORT=3002
EXPOSE 3002
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||3002)+'/health').then(r => r.ok ? process.exit(0) : process.exit(1))"
ENTRYPOINT ["dumb-init", "--"]
CMD ["bun", "run", "./dist/index.js"]
```

---

## PHASE 2B: DEPLOYMENT CLEANUP

### 2B.1: Remove render.yaml
```bash
$ rm -f render.yaml
```

### 2B.2: Remove Render References
In `src/app.ts`, find keep-alive timer. Either remove or gate:
```typescript
if (process.env.ENABLE_SELF_KEEPALIVE !== 'false') {
  // existing keep-alive
}
```

### 2B.3: Update railway.json
```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": { "builder": "DOCKERFILE", "dockerfilePath": "Dockerfile" },
  "deploy": {
    "startCommand": "bun run ./dist/index.js",
    "healthcheckPath": "/health",
    "healthcheckTimeout": 30,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 3
  }
}
```

---

## PHASE 2C: CODE QUALITY

### 2C.1: ESLint/Prettier (Lenient Start)
**.eslintrc.json:**
```json
{
  "root": true,
  "parser": "@typescript-eslint/parser",
  "plugins": ["@typescript-eslint"],
  "extends": ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  "parserOptions": { "project": "./tsconfig.json" },
  "rules": {
    "@typescript-eslint/no-explicit-any": "warn",
    "no-console": "warn"
  },
  "ignorePatterns": ["dist/", "node_modules/", "coverage/", "data/"]
}
```
**NO** `recommended-requiring-type-checking` yet.

**.prettierrc:**
```json
{ "semi": true, "singleQuote": true, "tabWidth": 2, "trailingComma": "es5", "printWidth": 100 }
```

### 2C.2: Run Lint
```bash
$ bun run lint
```
- If **>50 errors**: add `.eslintignore` or rule overrides for legacy files.
- If **syntax errors**: fix before proceeding.

### 2C.3: Pre-commit Hook (Lightweight)
```bash
$ bun add -d husky
$ bunx husky init
```
**.husky/pre-commit:**
```bash
#!/bin/sh
. "$(dirname "$0")/_/husky.sh"
if git diff --cached --name-only | grep -qE '\.(key|p12|pfx)$'; then
  echo "ERROR: Private key files detected."
  exit 1
fi
bun run lint
bun run typecheck
```
**NO build or test** in pre-commit (too slow). Leave to CI.

---

## PHASE 2D: OBSERVABILITY

### 2D.1: Correlation ID Middleware
**`src/middleware/correlationId.ts`:**
```typescript
import { v4 as uuidv4 } from 'uuid';
import { Request, Response, NextFunction } from 'express';

declare global {
  namespace Express {
    interface Request { correlationId: string; }
  }
}

export function correlationIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const id = req.get('x-correlation-id') || uuidv4();
  req.correlationId = id;
  res.setHeader('x-correlation-id', id);
  next();
}
```
**Wire into `src/servers/httpServer.ts`** AFTER `express.json()`.

### 2D.2: Prometheus Metrics (HTTP Only)
**`src/middleware/metrics.ts`:**
```typescript
import { Request, Response, NextFunction } from 'express';
import client from 'prom-client';

const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total', help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status'], registers: [register]
});

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds', help: 'HTTP request duration',
  labelNames: ['method', 'route'], buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5], registers: [register]
});

export function metricsMiddleware(req: Request, res: Response, next: NextFunction) {
  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {
    const route = req.route?.path || req.path;
    httpRequestsTotal.inc({ method: req.method, route, status: res.statusCode.toString() });
    end({ method: req.method, route });
  });
  next();
}

export async function metricsHandler(req: Request, res: Response) {
  const internalSecret = process.env.INTERNAL_HEALTH_SECRET;
  const ip = req.ip || req.socket.remoteAddress || '';
  const isLoopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);
  const isInternal = isLoopback || (Boolean(internalSecret) && req.headers['x-internal-health'] === internalSecret);
  if (!isInternal) { res.status(403).json({ error: 'Forbidden' }); return; }
  res.setHeader('Content-Type', register.contentType);
  res.send(await register.metrics());
}
```
**Wire into `src/servers/httpServer.ts`**.

### 2D.3: InfluxDB — `.env.example` Only
**Do NOT change existing InfluxDB logic.** Just document in `.env.example`:
```bash
# InfluxDB (optional — enabled only when INFLUXDB_TOKEN is set)
# INFLUXDB_URL=http://localhost:8086
# INFLUXDB_TOKEN=your-token
# INFLUXDB_ORG=statsmqtt
# INFLUXDB_BUCKET=metrics
# INFLUXDB_RETENTION_DAYS=30
```

---

## PHASE 2E: CI/CD

### 2E.1: GitHub Actions
**.github/workflows/ci.yml:**
```yaml
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
        with:
          bun-version: "1.1.0"  # PINNED, not "latest"
      - run: bun install --frozen-lockfile
      - run: bun run lint
      - run: bun run typecheck
      - run: bun run build
      - run: bun run test:unit
```

### 2E.2: README Update
- Replace all `npm` commands with `bun`
- Remove Render references
- Add Railway deployment instructions

---

## FINAL VERIFICATION

Run these **exact** commands and show **all output**:
```bash
$ bun run build
$ bun run lint
$ bun run typecheck
$ bun test tests/unit 2>&1 | tail -5
$ git status --short
$ git log --oneline -3
```

If all pass:
```bash
$ git add -A
$ git commit -m "chore: Bun migration, ESLint, metrics, CI/CD, Railway deploy"
```

---

## "PHASE 2 COMPLETE" Definition

ALL must be true:
- [ ] `bun run build` passes
- [ ] `bun run lint` passes (0 errors)
- [ ] `bun run typecheck` passes
- [ ] `bun test tests/unit` passes (or documented Jest fallback)
- [ ] `render.yaml` deleted
- [ ] No Render refs in `src/app.ts`
- [ ] `railway.json` has healthcheck
- [ ] `.eslintrc.json` exists (no type-checking rules)
- [ ] `.husky/pre-commit` executable
- [ ] Correlation ID middleware wired
- [ ] Prometheus metrics wired
- [ ] `.github/workflows/ci.yml` pinned to Bun 1.1.0
- [ ] README uses `bun` not `npm`
- [ ] Git commit made
- [ ] Git status clean

**Do not claim Phase 2 complete until every box is checked with evidence.**

---

## COMPLETION HISTORY

### Completed Tasks

**Phase 2A: FOUNDATION (All Completed)**
- [x] **2A.1**: Added missing devDependencies to package.json
- [x] **2A.2**: Checked lockfile name (bun.lock exists)
- [x] **2A.3**: Created bunfig.toml with test preload
- [x] **2A.4**: Tests migrated to Bun (initial verification completed)
- [x] **2A.5**: Updated tsconfig.json with proper module types
- [x] **2A.6**: Fixed Dockerfile with proper lockfile and build stages

**Phase 2B: DEPLOYMENT CLEANUP (All Completed)**
- [x] **2B.1**: Removed render.yaml file
- [x] **2B.2**: Removed Render references from src/app.ts
- [x] **2B.3**: Updated railway.json with proper Railway configuration

**Phase 2C: CODE QUALITY (All Completed)**
- [x] **2C.1**: Created .eslintrc.json with lenient rules
- [x] **2C.2**: Ran lint (completed with code fixes applied)
- [x] **2C.3**: Setup pre-commit hooks with husky

**Phase 2D: OBSERVABILITY (All Completed)**
- [x] **2D.1**: Created correlationIdMiddleware in src/middleware/correlationId.ts
- [x] **2D.2**: Created metrics middleware in src/middleware/metrics.ts
- [x] **2D.3**: Updated .env.example with InfluxDB documentation

**Phase 2E: CI/CD (All Completed)**
- [x] **2E.1**: Created GitHub Actions CI workflow
- [x] **2E.2**: Updated README with bun commands and Railway instructions

**Final Verification (Completed — 2026-07-02)**
- [x] **bun run build**: passes (`--packages=external` for oci/swagger deps)
- [x] **bun run lint**: 0 errors (165 legacy warnings)
- [x] **bun run typecheck**: passes (TypeScript 5.7)
- [x] **bun test tests/unit**: 116 tests pass (added `supertest` devDep)
- [x] **git commit**: `chore: Bun migration, ESLint, metrics, CI/CD, Railway deploy`

**Implementation notes**
- `tsconfig.eslint.json` includes `tests/` for typed ESLint
- Keep-alive gated behind `ENABLE_SELF_KEEPALIVE=true` (off by default on Railway)
- `render.yaml` removed; `railway.json` deploy block added

---
