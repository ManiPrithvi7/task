# InfluxDB Two-Bucket Retention Compliance Documentation

## Overview

The application now uses a **dual-bucket architecture** to separate operational metrics from compliance/PKI data:

| Bucket | Purpose | Measurements | Suggested Retention |
|--------|---------|-------------|-------------------|
| **`metrics`** | Operational time-series | `device_metrics`, `social_metrics`, `system_metrics`, `instagram_fetch_audit`, `instagram_metrics`, `instagram_mqtt_delivery`, `instagram_circuit_event`, `instagram_attention_e2e`, `webhook_received`, `webhook_device_resolution`, `webhook_mqtt_delivery`, `milestone_crossed`, `rate_limit_events` | 30 days |
| **`pki_compliance`** | PKI hash chain + CT log + OTA release log | `pki_audit`, `ct_log`, `ota_release_log` | 1 year+ |

Configured via env vars: `INFLUXDB_BUCKET` (default: `metrics`) and `INFLUXDB_COMPLIANCE_BUCKET` (default: `pki_compliance`). See `src/config/index.ts` and `.env.example`.

## Migration from Single Bucket

Before deploying the dual-bucket code, ops must:

1. **Create `pki_compliance` bucket** in InfluxDB with long retention (1 year+).
2. **Set retention on `metrics` bucket** to ~30 days (via InfluxDB API/CLI).
3. **Migrate existing PKI data** — if `pki_audit` / `ct_log` already exist in the current `metrics` bucket, migrate them to avoid chain reset:

```flux
// Copy pki_audit from metrics → pki_compliance
from(bucket: "metrics")
  |> range(start: 0)
  |> filter(fn: (r) => r._measurement == "pki_audit")
  |> to(bucket: "pki_compliance", org: "<org>")

// Same for ct_log
from(bucket: "metrics")
  |> range(start: 0)
  |> filter(fn: (r) => r._measurement == "ct_log")
  |> to(bucket: "pki_compliance", org: "<org>")
```

Optional post-migration: drop `pki_audit` / `ct_log` series from `metrics` to avoid duplicate storage.

## Application Configuration

- `INFLUXDB_BUCKET` — Default `metrics` (operational bucket)
- `INFLUXDB_COMPLIANCE_BUCKET` — Default `pki_compliance` (PKI/compliance bucket)
- `METRICS_RETENTION_DAYS` — Default 30 (configurable via `.env`)
- Source: `src/config/index.ts`
- Usage: "Reserved hint" for operational guidance only; actual retention controlled by InfluxDB bucket policies

### Actual Retention Mechanism

InfluxDB retention is configured administratively:

- **Primary Control:** InfluxDB bucket retention policies
- **Applied by:** InfluxDB service administrators
- **Configuration Tool:** InfluxDB API/CLI (not through this application)

## Retention Policy Details

### Proposed Retention Periods

| Component | Suggested Days | Rationale |
|-----------|----------------|-----------|
| **Device Activity** | 30 | Standard industry practice |
| **OTA Events** | 90 | Auditing needs longer than device data |
| **Certificate Operations** | 180 | Compliance requirements |
| **PKI Audit Chain** | 365+ | Chain continuity requirement |

### Architecture

```
InfluxService (dual-bucket routing)
  ├── metricsWriteApi → "metrics" bucket (30d retention)
  └── complianceWriteApi → "pki_compliance" bucket (1yr+ retention)

Disk queues (optional WAL):
  ├── {diskQueuePath}.metrics
  └── {diskQueuePath}.compliance
```

Query API is org-scoped; bucket is specified in each Flux query via `resolveBucket(target)`.

## Compliance Considerations

### Regulatory Requirements

| Regulation | Requirement | Compliance Status |
|------------|-------------|-------------------|
| **GDPR** | Data minimization | Not applicable to metrics |
| **SOX** | Audit trail retention | 90-180 days (pki_compliance meets this) |
| **HIPAA** | Protected health info storage | No PHI in metrics |
| **Privacy Act** | Data retention periods | Addressed by tiered buckets |

### Data Loss Risks

1. **Administrative Dependency:** Retention requires InfluxDB admin action; application cannot self-police
2. **No Tiering:** Cannot apply different retention to different data types
3. **No Enforcement:** Application may write excessive historical data
4. **No Cost Control:** Retention policy affects storage costs but isn't optimized

## Recommendations

### Immediate Actions (Pre-Pilot)

1. **Document Administrative Controls:** Ensure InfluxDB bucket policies match operational requirements
2. **Monitor Usage:** Track actual data growth and retention impact
3. **Cost Awareness:** Document storage costs at different retention periods

### Post-Pilot Actions

1. **Automated Retention:** Implement application-side enforcement in `POST-PILOT_ROADMAP.md`
2. **Bucket Segregation:** Separate retention for different data types
3. **Policy Lifecycle:** Automate retention policy adjustments based on compliance requirements

## Monitoring & Alerting

### Current Monitoring

- **InfluxDB dashboards:** Track storage usage and data volume
- **Application logs:** Track data writes and errors
- **Cost reporting:** Monitor infrastructure costs

### Recommended Enhancements

- Alert when retention periods approach their limits
- Monitor data growth against retention policy
- Track compliance adherence through audits

## Financial Impact

| Retention Period | Monthly Cost (Estimated) | Data Volume (GB) |
|------------------|--------------------------|-------------------|
| 30 Days | $X.XX | 10-50 |
| 90 Days | $X.XX | 30-150 |
| 180 Days | $X.XX | 60-300 |

## Technical Challenges

### Integration Points

1. **InfluxDB Admin:** Requires coordination with infrastructure team
2. **Configuration Drift:** Manual management increases consistency risk
3. **Cost Estimation:** Current InfluxDB pricing requires validation

### Development Barriers

1. **No Native Support:** Application cannot modify InfluxDB retention via API
2. **Single Point of Control:** All metrics share the same retention
3. **Implementation Overhead:** Automated solution requires significant development

## Conclusion

The dual-bucket architecture addresses the **no-tiering** limitation of the previous single-bucket approach. PKI audit data now lives in a separate bucket with longer retention, while operational metrics remain in the short-retention metrics bucket.

For true compliance with retention requirements:

- **Immediate:** Document administrative controls and document responsibilities
- **Post-Pilot:** Consider custom metrics service or migration to InfluxDB-compatible solution with API control

## Appendices

### Appendix A: Retention Policy History

- [ ] Document current retention policy changes if modified
- [ ] Track administrative decisions and reasoning
- [ ] Maintain audit log of retention policy enforcement attempts

### Appendix B: Cost Tracking

- [ ] Implement automated cost tracking for different retention periods
- [ ] Document actual costs vs. estimates
- [ ] Set up cost alerts at predetermined thresholds

## References

- `src/config/index.ts` — Configuration documentation
- `src/services/influxService.ts` — Dual-bucket routing implementation
- InfluxDB bucket administration documentation
- Cloud infrastructure cost reporting
