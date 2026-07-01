# 🔴 Action Required: Critical Security & Infrastructure Fixes

## Summary
The current codebase has already implemented several important security improvements, but several critical items remain to be addressed for production readiness.

## ✅ Complete

### Security (P0 Priority)
1. **H-1: mTLS Fingerprint Binding** - Already implemented in `src/middleware/mtlsAuth.ts`
2. **H-2: Admin JWT Scope Hardening** - Already implemented in `src/routes/otaAdminRoutes.ts`
3. **1.4: WebSocket Server Removal** - **COMPLETED**
4. **1.5: Health Endpoint Information Disclosure** - Already implemented
5. **1.6: CORS Origin Restriction** - Already implemented
6. **1.7: CSR Rate Limiter (Redis fallback)** - Already implemented

### OTA (Pilot v1)
7. **1.3: Pilot OTA Route** - Already implemented

## ❌ Action Required

### 1. Immediate (P1 Priority)
#### 1.1 Remove Committed Private Keys from Repo
**Files to remove:**
- `src/Proof-ca/*.key`
- `src/certs/root-ca.key`
- `data/ca/*.key`
- `data/mqtt-client/*.key`
- `broker/certs/*.key`

**Steps:**
1. Remove private key files (keep public `.crt` for cert exchange)
2. Update `.gitignore` to include `*.key` patterns
3. Replace with environment variable injection

#### 1.2 Update .env.example with Admin Auth
Add to `.env.example`:
```
# Admin JWT scope for admin routes
ADMIN_EMAIL_DOMAINS=withproof.io
ADMIN_USER_IDS=
```

### 2. Medium Priority (2-3 days)
#### 2.1 Migrate Runtime to Bun
Complete `package.json` migration to Bun:
- Replace scripts with Bun commands
- Update `engines.bun` field
- Update Dockerfile to use Bun
- Update `.dockerignore`
- Update Dockerfile harduening

#### 2.2 Remove Render Configuration
- Delete `render.yaml`
- Remove Render-specific env vars from `.env.example`
- Update README to mention Railway only

#### 2.3 Add ESLint + Prettier
- Add `@typescript-eslint` packages to devDependencies
- Create `.eslintrc.json`, `.prettierrc`, `.eslintignore`
- Add lint/format scripts to `package.json`

### 3. Additional (Requires more time)
#### 3.1 Core Infrastructure
- Add correlation ID middleware (`src/middleware/correlationId.ts`)
- Add Prometheus metrics endpoint (`src/middleware/metrics.ts`)
- Make InfluxDB a required dependency (fail fast on startup)
- Add comprehensive InfluxDB health checks

#### 3.2 Testing & CI/CD
- Update `package.json` with proper test coverage config
- Add GitHub Actions CI workflow (`.github/workflows/ci.yml`)
- Add Railway deployment config (`railway.json`)
- Add pre-commit hooks

#### 3.3 Documentation
- Update README.md with Bun + Railway architecture
- Add `docs/CAPACITY.md` for fleet size
- Add `docs/PILOT_V1_EXCEPTIONS.md` for pilot notes

## 🚨 Urgent Tasks

### Right Now:
1. **Remove Private Keys** - Highest security risk
2. **Update .env.example** - Missing admin auth config

### Next Priority:
3. **Migrate to Bun** - Performance and modernization
4. **Remove Render** - Cleanup legacy deployment

## 📍 Location References

- Security: `src/middleware/`
- OTA: `src/routes/otaRoutes.ts`
- Admin Auth: `src/routes/otaAdminRoutes.ts`
- Configuration: `package.json`, `.env.example`
- Deployment: `Dockerfile`, `render.yaml`
- Runtime: `package.json`, `package-lock.json`

## Best Practices

- Never commit `.key`, `.pem`, `.p12`, `.pfx` files
- Use environment variable injection for secrets
- Document all configuration in `.env.example`
- Always add a TODO comment for pilot-v1 exceptions
- Include risk notes for temporary exceptions

---

**Would you like me to:**
1. Generate a git patch for the changes?
2. Begin implementation of any specific items?
3. Create a script to help with key removal?
