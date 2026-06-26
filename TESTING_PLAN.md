# Comprehensive Endpoint Testing Plan

## Overview
This plan outlines a systematic approach to testing all endpoints in the proofmqtt application to ensure bulletproof functionality across services and routes.

## Phase 1: Route-Level Testing (Parallel Execution)

### 1.1 Webhook Routes (`/api/webhooks/*`)
**Endpoints:**
- `POST /api/webhooks/google-business-reviews`

**Test Categories:**
- ✅ **Input Validation** - Missing headers, invalid JSON, malformed payloads
- ✅ **Rate Limiting** - Request throttling enforcement
- ✅ **Authentication** - Bearer token validation
- ✅ **Business Logic** - Webhook processing and MQTT publishing
- ✅ **Error Handling** - Invalid payloads, processing failures
- ✅ **Security** - Raw body capture, content-type validation

**Existing Tests:**
- `tests/unit/routes/webhookRoutes.test.ts`
- `tests/unit/webhooks/dedupe/redisDedupe.test.ts`

### 1.2 Promotion Routes (`/api/v1/promotions/*`)
**Endpoints:**
- `GET /api/v1/promotions`
- `POST /api/v1/promotions`
- `GET /api/v1/promotions/:promotionId`
- `PUT /api/v1/promotions/:promotionId`
- `DELETE /api/v1/promotions/:promotionId`

**Test Categories:**
- ✅ **CRUD Operations** - Create, read, update, delete
- ✅ **Validation** - Input schema validation
- ✅ **Authentication** - Admin token requirements
- ✅ **Authorization** - Permission checks
- ✅ **Business Logic** - Promotion lifecycle management
- ✅ **Error Handling** - Not found, validation errors

**Existing Tests:**
- `tests/unit/routes/promotionRoutes.test.ts` (4 tests)
- `tests/unit/services/promotionService.test.ts`

### 1.3 Connections Routes (`/api/v1/connections/*`)
**Endpoints:**
- `GET /api/v1/connections`
- `POST /api/v1/connections`
- `GET /api/v1/connections/:connectionId`
- `PUT /api/v1/connections/:connectionId`
- `DELETE /api/v1/connections/:connectionId`

**Test Categories:**
- ✅ **CRUD Operations** - Full lifecycle testing
- ✅ **Connection Management** - Device and user connections
- ✅ **Authentication** - Session-based auth
- ✅ **State Management** - Connection states and transitions
- ✅ **Error Handling** - Invalid connection IDs, conflicts

**Existing Tests:**
- `tests/unit/routes/connectionsRoutes.test.ts` (4 tests)

## Phase 2: OTA Routes Testing

### 2.1 Device OTA Routes (`/api/v1/ota/*`)
**Endpoints:**
- `GET /api/v1/ota/download/:version` (firmware download)
- `POST /api/v1/ota/report` (OTA status reporting)

**Test Categories:**
- ✅ **Download Security** - mTLS certificate validation, rate limiting
- ✅ **OTA Reporting** - Device status updates, rollback handling
- ✅ **Rate Limiting** - Check/report endpoint throttling
- ✅ **Error Handling** - Invalid versions, certificate errors
- ✅ **Business Logic** - OTA state transitions, version matching

**Test Files:**
- `tests/unit/routes/otaRoutes.test.ts` (to be created)
- `tests/unit/services/otaService.test.ts` (to be created)

### 2.2 Admin OTA Routes (`/api/v1/admin/ota/*`)
**Endpoints:**
- `POST /api/v1/admin/ota/releases/init`
- `POST /api/v1/admin/ota/releases/finalize`
- `POST /api/v1/admin/ota/releases/:version/promote`
- `GET /api/v1/admin/ota/releases`
- `GET /api/v1/admin/ota/devices/:deviceId/ota`
- `POST /api/v1/admin/ota/push`
- `POST /api/v1/admin/ota/signing-confirm`

**Test Categories:**
- ✅ **Release Management** - Create, finalize, promote releases
- ✅ **Device Management** - Device OTA status and history
- ✅ **Fleet Operations** - Bulk push operations
- ✅ **Authentication** - Admin-only access control
- ✅ **Authorization** - Role-based permissions
- ✅ **Validation** - Version format, signature verification
- ✅ **Error Handling** - Permission denied, validation failures

**Test Files:**
- `tests/unit/routes/otaAdminRoutes.test.ts` (to be created)

## Phase 3: Infrastructure Routes Testing

### 3.1 Provisioning Routes (`/api/v1/onboarding/*`)
**Endpoints:**
- `POST /api/v1/onboarding/provisioning`
- `GET /api/v1/onboarding/provisioning/:token`

**Test Categories:**
- ✅ **Token Management** - Provisioning token lifecycle
- ✅ **Authentication** - Token validation, JWT verification
- ✅ **Authorization** - Device registration permissions
- ✅ **Error Handling** - Invalid tokens, expired tokens

**Test Files:**
- `tests/unit/routes/provisioningRoutes.test.ts` (to be created)

### 3.2 Config Routes (`/api/v1/config/*`)
**Endpoints:**
- `GET /api/v1/config`
- `PUT /api/v1/config`

**Test Categories:**
- ✅ **Configuration Management** - Read/write config
- ✅ **Authentication** - Admin-only access
- ✅ **Validation** - Config schema validation
- ✅ **Error Handling** - Invalid config, permission errors

**Test Files:**
- `tests/unit/routes/configRoutes.test.ts` (to be created)

### 3.3 Lifecycle Routes (`/api/v1/lifecycle/*`)
**Endpoints:**
- `POST /api/v1/lifecycle/shutdown`
- `POST /api/v1/lifecycle/restart`

**Test Categories:**
- ✅ **System Operations** - Graceful shutdown/restart
- ✅ **Authentication** - Admin-only access
- ✅ **Error Handling** - Operation failures, timeouts

**Test Files:**
- `tests/unit/routes/lifecycleRoutes.test.ts` (to be created)

### 3.4 Recovery Routes (`/api/v1/recovery/*`)
**Endpoints:**
- `POST /api/v1/recovery/sessions`
- `GET /api/v1/recovery/sessions/:sessionId`
- `POST /api/v1/recovery/sessions/:sessionId/verify`

**Test Categories:**
- ✅ **Recovery Sessions** - Session creation and management
- ✅ **Authentication** - Session token validation
- ✅ **Authorization** - Session access control
- ✅ **Error Handling** - Invalid sessions, expired sessions

**Test Files:**
- `tests/unit/routes/recoveryRoutes.test.ts` (to be created)

## Phase 4: Service-Level Testing

### 4.1 OTA Service (`src/services/otaService.ts`)
**Test Categories:**
- ✅ **Update Resolution** - Device firmware offer resolution
- ✅ **Release Ingestion** - CI webhook processing
- ✅ **Device State Management** - OTA state transitions
- ✅ **Rollback Handling** - Failure recovery and blocking
- ✅ **Fleet Management** - Redis-backed fleet state
- ✅ **Release Validation** - Signature and version validation

**Test Files:**
- `tests/unit/services/otaService.test.ts` (to be created)

### 4.2 Other Critical Services
- `tests/unit/services/deferredDeviceWork.test.ts`
- `tests/unit/services/recoverySessionService.test.ts`
- `tests/unit/services/mqttChangeDetection.test.ts`
- `tests/unit/services/mqttIngressRouter.test.ts`
- `tests/unit/services/pos/readPosDailyAggregate.test.ts`
- `tests/unit/services/campaignSchedule.test.ts`

## Testing Methodology

### 4.1 Test Structure
```typescript
// Each test file follows this pattern:
import { create[Service]Routes } from '@/routes/[service]Routes';
import type { [Service]RoutesDeps } from '@/routes/[service]Routes';

// Mock dependencies
const mock[Service] = {...};

// Build test app
function buildApp() {
  const app = express();
  app.use(create[Service]Routes(mockDeps));
  return app;
}

// Test cases
describe('[Service]Routes', () => {
  beforeEach(() => {
    // Setup
  });
  
  it('should [test scenario]', async () => {
    // Test implementation
  });
});
```

### 4.2 Test Categories
1. **Unit Tests** - Individual service functions
2. **Integration Tests** - Route endpoint testing
3. **End-to-End Tests** - Full workflow scenarios
4. **Security Tests** - Authentication/authorization
5. **Performance Tests** - Rate limiting, load testing
6. **Error Handling Tests** - Invalid inputs, edge cases

### 4.3 Test Coverage Requirements
- ✅ **Endpoint Coverage** - 100% of all defined endpoints
- ✅ **Error Scenarios** - All error paths tested
- ✅ **Authentication** - All auth flows tested
- ✅ **Authorization** - Permission boundaries tested
- ✅ **Input Validation** - All input schemas tested
- ✅ **Business Logic** - Core functionality tested
- ✅ **Edge Cases** - Boundary conditions tested

## Implementation Schedule

### Week 1: Core Routes
1. **Day 1-2:** Webhook Routes comprehensive testing
2. **Day 3-4:** Promotion Routes CRUD testing
3. **Day 5:** Connections Routes testing

### Week 2: OTA Routes
1. **Day 1-2:** Device OTA routes testing
2. **Day 3-4:** Admin OTA routes testing
3. **Day 5:** OTA service unit testing

### Week 3: Infrastructure Routes
1. **Day 1-2:** Provisioning routes testing
2. **Day 3-4:** Config routes testing
3. **Day 5:** Lifecycle and recovery routes testing

### Week 4: Service Integration
1. **Day 1-2:** OTA service comprehensive testing
2. **Day 3-4:** Other service testing
3. **Day 5:** Cross-service integration testing

## Test Organization

### Directory Structure
```
tests/unit/
├── routes/
│   ├── webhookRoutes.test.ts
│   ├── promotionRoutes.test.ts
│   ├── connectionsRoutes.test.ts
│   ├── otaRoutes.test.ts
│   ├── otaAdminRoutes.test.ts
│   ├── provisioningRoutes.test.ts
│   ├── configRoutes.test.ts
│   ├── lifecycleRoutes.test.ts
│   └── recoveryRoutes.test.ts
├── services/
│   ├── otaService.test.ts
│   ├── promotionService.test.ts
│   ├── deferredDeviceWork.test.ts
│   ├── recoverySessionService.test.ts
│   ├── mqttChangeDetection.test.ts
│   ├── mqttIngressRouter.test.ts
│   ├── pos/
│   │   └── readPosDailyAggregate.test.ts
│   └── campaignSchedule.test.ts
└── webhooks/
    ├── verify/
    │   ├── shopifySquare.test.ts
    │   └── gmb.test.ts
    └── dedupe/
        └── redisDedupe.test.ts
    └── webhookHandlers.metrics.test.ts
```

### Test File Naming Convention
- `test.ts` - Unit tests for services
- `Routes.test.ts` - Integration tests for routes
- `[Feature].test.ts` - Feature-specific tests

## Quality Assurance

### Test Execution Order
1. **Unit Tests** - Service functions
2. **Route Tests** - Endpoint testing
3. **Integration Tests** - Cross-service workflows
4. **End-to-End Tests** - Full application scenarios

### Bug Fixing Process
1. **Test Failure Analysis** - Identify root cause
2. **Implementation Fix** - Address the issue
3. **Regression Testing** - Ensure no new bugs
4. **Documentation Update** - Update test expectations

### Continuous Integration
- ✅ Run all tests on every commit
- ✅ Fail fast on test failures
- ✅ Coverage reporting
- ✅ Performance monitoring

## Next Steps

1. **Create Test Files** - Implement all test files as outlined
2. **Run Existing Tests** - Ensure current tests pass
3. **Implement Missing Tests** - Add comprehensive tests for untested endpoints
4. **Fix Implementation Bugs** - Address any issues found during testing
5. **Document Test Results** - Maintain test documentation
6. **Establish CI/CD** - Automate test execution

This comprehensive testing plan ensures all endpoints are thoroughly tested, providing bulletproof functionality across the entire application.