# Post-Pilot Roadmap
# (Phase 3 Updates Post-Pilot v1)

Created: 2026-07-02
Based on Phase 2 completion and Phase 3 feasibility review

## Executive Summary

This roadmap documents the critical enhancements required after Pilot v1 launch to achieve production readiness and enable General Availability (GA). Based on the Phase 3 feasibility review, most production readiness improvements can be deferred until after pilot validation, with specific focus on metrics-driven monitoring and operational excellence.

The roadmap is organized by priority and timing, with clear dependencies and investment required.

## Guidance: Pilot v1 Launch Checklist

**Can launch Pilot v1 now** if you:

1. ✅ Document fleet capacity limits (documents/CAPACITY.md created)
2. ✅ Update security checklist for current code (docs/SECURITY_AUDIT_CHECKLIST.md created)
3. ✅ Document InfluxDB retention compliance (docs/COMPLIANCE.md created)
4. ✅ Implement global rate limiting (completed)
5. ⚠️ Setup Prometheus alerts (prometheus/alerts.yml created)

Launch Checklist for Pilot v1:
- [ ] Review Phase 3 items above
- [ ] Run `bun run lint` and `bun run typecheck` to verify no regressions
- [ ] Confirm `bun test tests/unit` still passes (116/116 tests)
- [ ] Document known limitations in pilot documentation
- [ ] Ensure all Phase 2 security controls remain intact

## Detailed Roadmap

### Week 1 (Document and Configure for Pilot)

#### Completed: P3.1 - Fleet Capacity Documentation
- ✅ Created `docs/CAPACITY.md`
- ⚠️ Includes "untested" disclaimer
- ⚠️ Recommends 100-500 devices for pilot

#### Completed: P3.7 - Security Audit Checklist
- ✅ Created `docs/SECURITY_AUDIT_CHECKLIST.md`
- ✅ Updated from pentest to current code state
- ✅ Documents pilot OTA exception (M-6)

#### Completed: P3.4 - Compliance Documentation
- ✅ Created `docs/COMPLIANCE.md`
- ✅ Clear: InfluxDB retention is admin-controlled, not enforced

#### Completed: P3.3 - Global Rate Limiting
- ✅ Updated `httpServer.ts` - removed `/api/v1/onboarding` from skipped endpoints
- ✅ Now `/api/v1/onboarding` is rate-limited like other endpoints
- ⚠️ Document: Per-process only (pilot OK), Redis store needed for GA

#### Completed: P3.2 - Prometheus Alerts
- ✅ Created `prometheus/alerts.yml`
- ✅ HTTP-only alerts only (due to metrics gaps)
- ⚠️ MQTT fleet alerts DEFERRED (see P3.2post-p1)

### Post-Pilot (Weeks 2-4)

#### P3.2post-p1 - Complete Prometheus Alerting

**Dependency:** Need metrics implementation, alert routing setup

| Priority | Task | Risk | Implementation |
|----------|------|------|----------------|
| **P1** | Add MQTT metrics (`mqtt_connected_devices`, `mqtt_messages_received_total`) | **High** | Code instrumentation, update `src/middleware/metrics.ts` |
| **P1** | Configure alert routing (PagerDuty/Slack, etc.) | **High** | Alertmanager routing, team setup |
| **P2** | Add MQTT alert rules (device disconnect, broker down) | **Medium** | Rules in `prometheus/alerts.yml` |
| **P2** | Create HTTP runbooks and incident procedures | **Medium** | Documentation templates |

**Timeline:** Requires metrics to be available first

#### P3.5 - Backup & Disaster Recovery

**Dependency:** Team sign-off on RTO/RPO, validation of MongoDB/Redis providers

| Priority | Task | Current Status |
|----------|------|----------------|
| **Review** | Inventory current backup strategies | Need team input |
| **Review** | MongoDB Atlas backup validation | Atlas team responsibility |
| **Review** | Redis Upstash/Persistence plan | Redis team responsibility |
| **Draft** | RTO/RPO specifications (1h/24h baseline) | Based on team input |

**Documentation:** Update `REDIS_CLOUD_SETUP.md`, `DEVICE_RECOVERY_FIRMWARE.md`

#### P3.6 - Secret Rotation Procedures

**Dependency:** Team sign-off on rotation frequencies, CA key inventory

| Priority | Task | Current Status |
|----------|------|----------------|
| **Complete** | `AUTH_SECRET` vs `JWT_SECRET` inventory | `CONFIG.md:175` docs this |
| **Complete** | CA key management (MQTT_TLS_CA_KEY_BASE64) | Documented as optional |
| **Review** | `admin` credential rotation plan | Need from infra team |
| **Draft** | Rotation checklist and procedures | Based on team input |

**Timeline:** Not required until GA or team requests

#### P3.8 - Operational Runbooks

**Dependency:** On-call team validation and dry-run review

| Priority | Content | Source |
|----------|---------|--------|
| **Draft** | Infrastructure incident response | Cross-reference existing docs |
| **Draft** | Service degradation procedures | Use `RECOVERY.md` as foundation |
| **Draft** | Performance tuning guidelines | Based on load test data (Post-Pilot) |
| **Test** | On-call escalation pathways | With on-call team |

**Cross-References:**
- `DEVICE_RECOVERY_FIRMWARE.md` (Flows 2/4)
- `REDIS_CONNECTION_FIX.md` (Redis troubleshooting)
- `OTA_FIRMWARE_CONTRACT.md` (OTA debugging)

#### P3.3post-p1 - GA Rate Limiting with Redis Store

**Dependency:** Multi-instance deployment plan, Redis infrastructure setup

| Priority | Task | Current Status |
|----------|------|----------------|
| **Document** | Per-process vs Redis store distinction | `httpServer.ts:91` documentation |
| **Plan** | Redis-backed rate limit store for GA | Document in `prommpts?` |
| **Test** | Load testing of rate limit implementation | Artillery/k6 testing |

**Implementation Notes:**
- `express-rate-limit` default is in-memory (per-process)
- Shared store required for multi-replica deployment
- Production GA requires Redis-backed store

## Risk Mitigation Summary

### Low Risk
- Documentation items (P3.1, P3.4, P3.7)
- Prometheus alert configuration (P3.2)

### Medium Risk
- Global rate limiting implementation (P3.3)
- CORS/Health endpoint security (P3.8)

### High Risk
- MQTT metrics implementation (P3.2post-p1)
- MongoDB/Redis backup validation (P3.5)
- Secret rotation complexity (P3.6)

## Success Criteria

### Pilot v1 Go-Live

| Area | Requirement |
|------|-------------|
| **Security** | All Phase 2 controls maintained, Phase 3 documentation created |
| **Operations** | Global rate limiting operational |
| **Monitoring** | Basic HTTP alerts configured, health checks working |
| **Documentation** | Capacity, security, and compliance documents created |
| **Reliability** | 99.9% uptime goal with monitoring alarms |

### GA Readiness (Post-Pilot)

| Area | Requirement |
|------|-------------|
| **Scaling** | Documented 100-500+ device capacity, load testing completed |
| **Monitoring** | Full Prometheus metrics and alerting with routing |
| **Resilience** | Backup/DR procedures tested and documented |
| **Operations** | Runbooks validated, on-call procedures in place |
| **Security** | Secret rotation documented, audit compliance maintained |

## Investment Summary

### Pilot v1
- **Person-days:** ~1 day of documentation writing
- **Infrastructure:** Existing (Phase 2 completed)
- **Critical path:** Documentation only

### Post-Pilot (Weeks 2-4)
- **Person-days:** ~2 weeks of development
- **Infrastructure:** Requires additional monitoring setup
- **Critical path:** Requires Phase 2 completion validation

### Key Decisions

1. **Launch Pilot v1 now** - Documentation items are "good enough" for pilot
2. **Defer heavy changes** until after pilot validation
3. **Phased approach** allows learning and adaptation
4. **Documentation-first approach** ensures consistency

## Timeline Updates

### Current (2026-07-02)
- Week 1: Phase 3 completion

### Week 2-4 (Post-Pilot)
- P3.2post-p1: Complete metrics + MQTT alerts
- P3.5: Backup/DR documentation
- P3.6: Secret rotation procedures
- P3.8: Runbook creation and testing

### Month 2 (Month 2)
- P3.3post-p1: GA rate limiting with Redis store
- Load testing and performance validation

## Close-out Checklist

### Pilot v1 Close
- [ ] All Prometheus alerts tested
- [ ] Documentation reviewed and approved
- [ ] Runbooks created (basic)
- [ ] Monitoring dashboard deployed
- [ ] Release notes prepared

### GA Preparation
- [ ] Backup/DR procedures validated
- [ ] Secret rotation implemented
- [ ] Load testing completed
- [ ] Performance benchmarks achieved
- [ ] Security audit re-run completed
- [ ] Full test coverage (>80%) met

## Notes

This roadmap is based on the current codebase state and assumes:

1. **Redis infrastructure** will be available for GA rate limiting
2. **MongoDB Atlas** will meet RTO/RPO requirements
3. **InfluxDB admin** will maintain retention policies
4. **On-call team** will validate runbooks

**Next Steps:** This roadmap should be used to sequence development after Pilot v1 launch, with clear milestones for success and handoffs for team dependencies.
