# 🚀 REVISED PHASE 3: PRODUCTION READINESS

## Rules
1. Execute steps **in order**. Do not skip.
2. Show **raw output** for every verification.
3. If a step fails, **stop and report**. Do not proceed.
4. Do not claim "done" until verification passes.
5. No options, no framing.

---

## PHASE 3A: FLEET & CAPACITY (Critical Validation)

### 3A.1: Document Fleet Size Limits
Create documentation file `docs/fleet-capacity.md`:
```markdown
# Fleet Capacity Limits

## Testing Performed
- [ ] Load testing with Artillery (target: 100+ concurrent devices)
- [ ] Connection validation (TCP keeps open >1000 ms)
- [ ] CPU/memory profiling under load

## Known Limits
- Maximum recommended devices: **TBD** (requires testing)
- Connection timeout: **TBD** (requires testing)
- Memory per device: **TBD** (requires testing)

## Metrics Collected
- CPU usage per device
- Memory usage per device
- Connection duration
- Message throughput (QoS 1/2)

## Deployment Warnings
- **CAUTION**: Fleet size validation pending
- Monitor: device.disconnections > 1% of total fleet
- Alert threshold: 10+ disconnections/minute sustained
```

### 3A.2: Verify InfluxDB Retention Policy
In `src/config/influxdb.ts`, verify retention policy is set:
```typescript
export const INFLUXDB_RETENTION = '30d'; // Default in .env.example
```
**Check:** Look for INFLUXDB_RETENTION_DAYS or similar configuration.

### 3A.3: Run Fleet Load Tests
```bash
npm install -g artillery
artillery run tests/load/fleet-capacity.yml
```
**Expected:** 100+ concurrent devices maintain connection >5 minutes

---

## PHASE 3B: BACKUP & DISASTER RECOVERY

### 3B.1: MongoDB Backup Strategy
Create backup strategy document `docs/mongo-backup.md`:
```markdown
# MongoDB Backup & DR Strategy

## Current State
- MongoDB running in production
- No automated backup system

## Recommended Actions
1. **Daily Automated Backups**
   - Use `mongodump` or cloud-native backup
   - Compress and encrypt backups
   - Store in multiple locations (local + cloud)

2. **Point-in-Time Recovery**
   - Configure oplog-based backup if possible
   - Test restore procedures monthly

3. **Disaster Recovery Plan**
   - Secondary MongoDB cluster in different region
   - 30-minute RPO, 2-hour RTO target
   - Document recovery procedures
```

### 3B.2: Redis Persistence
In `docker-compose.yml` or Dockerfile, ensure Redis persistence:
```yaml
# Example for docker-compose.yml
redis:
  restart: always
  volumes:
    - redis_data:/data
volumes:
  redis_data:
```

### 3B.3: Backup Testing
```bash
# Test MongoDB dump/restore
mongodump --db=mqtt --out=/tmp/backup_$(date +%Y%m%d)
mongorestore --db=mqtt /tmp/backup_$(date +%Y%m%d)
```
**Verify:** Restore completes within 30 minutes with no data loss

---

## PHASE 3C: SECURITY OPERATIONS

### 3C.1: Secret Rotation Plan
Create secret rotation policy document `docs/secret-rotation.md`:
```markdown
# Secret Rotation Plan

## Current Secrets
- `AUTH_SECRET`: JWT secret
- `INTERNAL_HEALTH_SECRET`: Metrics healthcheck
- CA keys (if using mTLS)

## Rotation Schedule
- `AUTH_SECRET`: Every 90 days
- `INTERNAL_HEALTH_SECRET`: Every 60 days
- CA keys: Every 180 days (if applicable)

## Rotation Process
1. Deploy new secrets to all instances
2. Wait for old secrets to expire (max 24 hours)
3. Verify authentication still works
4. Rotate secrets in external systems if connected

## Monitoring
- Alert on auth failures during rotation
- Log all secret rotations with correlation ID
```

### 3C.2: Monitoring Alert Setup
Create basic alert rules in `monitoring/prometheus/alerts.yml`:
```yaml
groups:
  - name: statsmqtt
    rules:
      # Error rate alert
      - alert: HighErrorRate
        expr: rate(http_requests_total{status=~"5.."}[5m]) / rate(http_requests_total[5m]) > 0.01
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High error rate detected"
          description: "Error rate is {{ $value }}% over last 5 minutes"

      # Device disconnection alert
      - alert: DeviceDisconnections
        expr: increase(device_disconnections_total[5m]) > 10
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "High device disconnection rate"
          description: "{{ $value }} disconnections in last 5 minutes"
```

### 3C.3: Rate Limiting on All Public Endpoints
In `src/servers/httpServer.ts`, add rate limiting middleware BEFORE existing middleware:
```typescript
import rateLimit from 'express-rate-limit';

// Apply rate limiting to all public routes
app.use('/api/public/', rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
}));
```

---

## PHASE 3D: MONITORING ENHANCEMENT

### 3D.1: Basic Alert Rules
Create Prometheus alert rules file:
```bash
mkdir -p monitoring/prometheus
cat > monitoring/prometheus/alerts.yml << EOF
groups:
  - name: statsmqtt-alerts
    rules:
      # CPU usage alert
      - alert: HighCPUUsage
        expr: (sum by (instance) (irate(cpu_usage_total{mode="system"}[5m])) / cpu_cores) > 0.8
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "High CPU usage on {{ \"$\".$1 }}"
          description: "CPU usage is {{ $value | humanizePercentage }}"

      # Memory usage alert
      - alert: HighMemoryUsage
        expr: (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) < 0.2
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Low memory available on {{ \"$\".$1 }}"
          description: "Only {{ $value | humanizePercentage }} memory available"

      # Connection count alert
      - alert: HighConnectionCount
        expr: mqtt_active_connections > 500
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "High MQTT connection count"
          description: "{{ $value }} active connections"
EOF
```

### 3D.2: Alert Testing
```bash
# Test alert firing
echo 'cpu_usage_total{mode="system"}=90000' >> test.prom
echo 'cpu_cores=100' >> test.prom
cat test.prom | promtool check metrics
```

---

## PHASE 3E: COMPLIANCE & DOCUMENTATION

### 3E.1: Compliance Checklist
Create compliance document `docs/compliance-checklist.md`:
```markdown
# Compliance Checklist

## Security Requirements
- [ ] All secrets rotated every 90 days
- [ ] Encryption at rest for backup data
- [ ] VPN access for admin interfaces
- [ ] Audit logging enabled for all operations
- [ ] Security scanning in CI/CD pipeline

## Operational Requirements
- [ ] Daily automated backups completed
- [ ] Disaster recovery procedures tested
- [ ] Fleet capacity documentation updated
- [ ] Monitoring alerts configured
- [ ] Rate limiting applied to all public endpoints

## Performance Requirements
- [ ] SLA monitoring implemented
- [ ] Performance baseline established
- [ ] Load testing completed
- [ ] Capacity planning documented
```

### 3E.2: Documentation Updates
- Update README with backup procedures
- Add runbook for incident response
- Document deployment checklists
- Create monitoring dashboards

---

## FINAL VERIFICATION

Run these **exact** commands and show **all output**:
```bash
$ bun run build
$ bun run lint
$ bun run typecheck
$ bun test tests/unit 2>&1 | tail -5
$ ls docs/fleet-capacity.md docs/mongo-backup.md docs/secret-rotation.md
$ cat monitoring/prometheus/alerts.yml | head -50
$ git status --short
$ git log --oneline -3
```

If all pass:
```bash
$ git add -A
$ git commit -m "docs: Add production readiness documentation and configs"
```

---

## "PHASE 3 COMPLETE" Definition

ALL must be true:
- [ ] Fleet capacity documentation created (`docs/fleet-capacity.md`)
- [ ] InfluxDB retention policy verified
- [ ] MongoDB backup strategy documented
- [ ] Redis persistence configured
- [ ] Secret rotation plan created
- [ ] Basic monitoring alerts created
- [ ] Rate limiting on all public endpoints configured
- [ ] Compliance checklist created
- [ ] All documentation files added to repo
- [ ] Git commit made
- [ ] Git status clean

**Do not claim Phase 3 complete until every box is checked with evidence.**

---

## COMPLETION HISTORY

### Completed Tasks

**Phase 3A: FLEET & CAPACITY**
- [x] Created fleet capacity documentation

**Phase 3B: BACKUP & DISASTER RECOVERY**
- [x] Created MongoDB backup strategy documentation
- [ ] Redis persistence configured in docker-compose.yml

**Phase 3C: SECURITY OPERATIONS**
- [x] Created secret rotation plan
- [ ] Rate limiting middleware added to httpServer.ts
- [ ] Monitoring alert rules created

**Phase 3D: MONITORING ENHANCEMENT**
- [ ] Basic alert rules created in monitoring/prometheus/alerts.yml

**Phase 3E: COMPLIANCE & DOCUMENTATION**
- [ ] Compliance checklist created
- [ ] All documentation files organized

**Final Verification (TBD)**
- [ ] All commands run and verified
- [ ] Documentation files checked
- [ ] Alert rules verified
- [ ] Git commit made

---