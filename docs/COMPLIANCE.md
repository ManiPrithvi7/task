# InfluxDB Two-Bucket Retention Compliance Documentation

## Overview

The application uses a **dual-bucket architecture** to separate operational metrics from compliance/PKI data:

| Bucket | Purpose | Measurements | Retention |
|--------|---------|-------------|-------------------|
| **`metrics`** | Operational time-series | `instagram_fetch_audit`, `ig_metrics`, `ig_milestone`, `gmb_metrics`, `gmb_milestone`, `profile_baseline`, `instagram_attention_e2e`, `mqtt_delivery`, `gmb_webhook_audit`, `device_ota_events`, `device_active` | **30 days** |
| **`pki_compliance`** | PKI hash chain + CT log + OTA release log + device state chain | `pki_audit`, `ct_log`, `ota_release_log`, `device_state_log` | **3650 days** (10 years — WebTrust/ETSI) |

Configured via env vars: `INFLUXDB_BUCKET` (default: `metrics`) and `INFLUXDB_COMPLIANCE_BUCKET` (default: `pki_compliance`). See `src/config/index.ts` and `.env.example`.

**InfluxDB retention is per-bucket, not per-measurement.** All measurements in a bucket share that bucket's retention policy. The application cannot set retention independently — it is an administrative control via InfluxDB CLI/API.

---

## Migration from Single Bucket

Before deploying the dual-bucket code, ops must:

1. **Create `pki_compliance` bucket** in InfluxDB with **3650d** retention.
2. **Set retention on `metrics` bucket** to **30 days** (via InfluxDB API/CLI).
3. **Migrate existing PKI data** — if compliance measurements already exist in the `metrics` bucket (from before dual-bucket routing), migrate them to avoid chain reset / data loss:

```flux
// Copy pki_audit from metrics → pki_compliance
from(bucket: "metrics")
  |> range(start: 0)
  |> filter(fn: (r) => r._measurement == "pki_audit")
  |> to(bucket: "pki_compliance", org: "<org>")

// Copy ct_log from metrics → pki_compliance
from(bucket: "metrics")
  |> range(start: 0)
  |> filter(fn: (r) => r._measurement == "ct_log")
  |> to(bucket: "pki_compliance", org: "<org>")

// Copy ota_release_log from metrics → pki_compliance
from(bucket: "metrics")
  |> range(start: 0)
  |> filter(fn: (r) => r._measurement == "ota_release_log")
  |> to(bucket: "pki_compliance", org: "<org>")
```

Optional post-migration: drop `pki_audit` / `ct_log` / `ota_release_log` series from `metrics` to avoid duplicate storage.

### Post-deploy retention command

```bash
influx bucket update --name pki_compliance --retention 3650d --org <org>
influx bucket update --name metrics --retention 30d --org <org>
```

---

## Application Configuration

| Env / setting | Role |
|---|---|
| `INFLUXDB_BUCKET` | Operational bucket name (default `metrics`) |
| `INFLUXDB_COMPLIANCE_BUCKET` | Compliance bucket name (default `pki_compliance`) |
| `METRICS_RETENTION_DAYS` | **Not an application control.** Documented hint only (`src/config/index.ts` → `metricsRetentionDays`). Actual retention is set exclusively via InfluxDB bucket policies. |

Source: `src/config/index.ts`, `.env.example`.

### Actual Retention Mechanism

- **Primary control:** InfluxDB bucket retention policies
- **Applied by:** InfluxDB service administrators
- **Configuration tool:** InfluxDB API/CLI (not through this application’s write path)

---

## Retention Policy Details

### Retention Periods

| Bucket | Retention | Measurements | Rationale |
|--------|-----------|-------------|-----------|
| `metrics` | 30d | `instagram_fetch_audit`, `ig_metrics`, `ig_milestone`, `gmb_metrics`, `gmb_milestone`, `profile_baseline`, `instagram_attention_e2e`, `mqtt_delivery`, `gmb_webhook_audit`, `device_ota_events`, `device_active` | Operational monitoring and dashboard trends — no compliance requirement beyond 30d |
| `pki_compliance` | 3650d | `pki_audit`, `ct_log`, `ota_release_log`, `device_state_log` | WebTrust/ETSI CA audit (7yr+), certificate lifetime transparency, firmware release integrity, device state chain continuity |

**Product decision (OTA / device events):** `device_ota_events` and `device_active` remain in the `metrics` bucket at **30d**. There is no separate 90-day OTA retention today. If 90-day OTA retention becomes a product requirement, choose one of:

1. Increase `metrics` bucket retention to 90 days (affects all 11 metrics measurements), or
2. Create a third bucket (e.g. `device_audit`) with 90-day retention and move those measurements there.

### Architecture

```
InfluxService (dual-bucket routing)
  ├── metricsWriteApi → "metrics" bucket (30d retention)
  └── complianceWriteApi → "pki_compliance" bucket (3650d retention)

Disk queues (optional WAL):
  ├── {diskQueuePath}.metrics
  └── {diskQueuePath}.compliance

BaseInfluxRepo.submit(point, BucketTarget, …)
  ├── BucketTarget.METRICS    → metrics WriteApi / metrics disk queue
  └── BucketTarget.COMPLIANCE → compliance WriteApi / compliance disk queue
```

Query API is org-scoped; bucket is specified in each Flux query via `resolveBucket(target)`.

---

## Compliance Considerations

### Regulatory Requirements

| Regulation | Requirement | Compliance Status |
|------------|-------------|-------------------|
| **GDPR** | Data minimization, pseudonymization | ✅ `device_active.ip_hash` is SHA-256 pseudonymized; `user_id_at_time` is a user reference on `device_active` / compliance logs. 30-day retention in the `metrics` bucket supports data minimization for operational fields. |
| **WebTrust/ETSI** | CA audit log retention (typically 7+ years) | ✅ `pki_audit` in `pki_compliance` with **3650d** retention |
| **CT Policy** | Certificate transparency log retention | ✅ `ct_log` in `pki_compliance` with **3650d** retention |
| **SOX** | Audit trail retention (5–7 years) | ✅ Compliance measurements (`pki_audit`, `ct_log`, `ota_release_log`, `device_state_log`) in the 3650d bucket |
| **HIPAA** | Protected health info storage | No PHI in these measurements |

### Data Loss Risks

1. **Per-measurement retention is not possible within a bucket.** If a specific measurement (e.g. `device_ota_events`) needs longer retention than the bucket default, either extend the whole bucket or move the measurement to a separate bucket. Mitigation: document retention-mismatch measurements and create additional buckets if product requires it.

2. **Compliance bucket retention requires administrative action.** If `pki_compliance` is not set to **3650d** by ops, the PKI audit chain, CT log, OTA release log, and device state chain will be deleted after InfluxDB’s default retention. Mitigation: verify retention as part of the deployment checklist; prefer a boot-time health check that logs a warning when compliance retention is below 3650d (see Recommendations).

3. **Mis-routed writes.** If a repo accidentally writes compliance data to the `metrics` bucket, it will be deleted after 30 days. Mitigation: `BaseInfluxRepo.submit()` routes by `BucketTarget`; new repos must specify the correct target. Dual WriteApis and separate disk queues reduce accidental mixing.

4. **Cost growth on the compliance bucket.** 3650d retention increases storage cost over time; monitor volume and InfluxDB Cloud pricing.

---

## Recommendations

### Immediate Actions (Pre-Pilot / Deploy)

1. Set bucket policies: `metrics` → **30d**, `pki_compliance` → **3650d**
2. Run migration Flux for `pki_audit`, `ct_log`, and `ota_release_log` if any still live in `metrics`
3. Confirm retention via InfluxDB CLI/UI as part of the deploy checklist
4. Monitor storage growth on both buckets

### Boot-time retention verification (recommended)

`InfluxService.healthCheck()` already probes InfluxDB health and API reachability. Extend it (or a one-shot init check) to read the compliance bucket retention and warn if below 3650 days:

```typescript
// Recommended addition to influxService health/init — verify compliance bucket retention
const buckets = await this.bucketsApi.getBuckets({ org, name: complianceBucket });
const bucket = buckets.buckets?.[0];
if (bucket?.retentionRules?.[0]?.everySeconds !== undefined) {
  const retentionDays = bucket.retentionRules[0].everySeconds / 86400;
  if (retentionDays < 3650) {
    logger.warn(
      `pki_compliance bucket retention is ${retentionDays}d — recommended 3650d for WebTrust/ETSI compliance`
    );
  }
}
```

The application still cannot *set* retention; it can only **detect misconfiguration** and alert operators.

### Post-Pilot Actions

1. Decide whether OTA/device events need >30d retention (third bucket vs raise `metrics` retention)
2. Implement the boot-time retention warning above if not already shipped
3. Automate cost/usage reporting for the compliance bucket

---

## Monitoring & Alerting

### Current Monitoring

- InfluxDB dashboards: storage usage and data volume
- Application logs: write failures and disk-queue backpressure
- Cost reporting: infrastructure / InfluxDB Cloud spend

### Recommended Enhancements

- Alert when `pki_compliance` retention drifts below 3650d
- Alert on unusual write volume to either bucket
- Periodic audit that compliance measurements are only present in `pki_compliance`

---

## Financial Impact

Values below are **placeholders** — fill after InfluxDB Cloud (or self-hosted) pricing confirmation.

| Retention Period | Monthly Cost (Estimated) | Data Volume (GB) |
|------------------|--------------------------|-------------------|
| 30 Days (`metrics`) | $X.XX | 10–50 |
| 3650 Days (`pki_compliance`) | $X.XX | TBD (grows with cert/OTA/device-state volume) |

---

## Technical Challenges

### Integration Points

1. **InfluxDB Admin:** Retention requires coordination with the infrastructure team
2. **Configuration Drift:** Manual bucket policies can diverge from this document
3. **Cost Estimation:** Confirm InfluxDB pricing against actual compliance-bucket growth

### Development Barriers

1. **No write-path retention control:** The app cannot change InfluxDB retention via the metrics write path
2. **Bucket-level granularity:** All measurements in a bucket share one retention (by design)
3. **Detection vs enforcement:** Boot checks can warn; only admin CLI/API can fix retention

---

## Conclusion

The dual-bucket architecture provides **tiered retention**: short-lived operational metrics (`metrics`, 30d) vs long-lived compliance evidence (`pki_compliance`, 3650d), with routing enforced in `BaseInfluxRepo.submit()` via `BucketTarget`.

For deploy readiness:

- **Ops:** Set and verify bucket retention (30d / 3650d); migrate any leftover compliance series from `metrics`
- **App:** Keep routing correct; optionally warn on boot when compliance retention is too short
- **Product:** Explicitly decide if OTA/device events need longer than 30d (today: no — they stay in `metrics`)

---

## Appendices

### Appendix A: Retention Policy History

- [ ] Document current retention policy changes if modified
- [ ] Track administrative decisions and reasoning
- [ ] Record deploy checklist confirmation of 3650d on `pki_compliance`

### Appendix B: Cost Tracking

- [ ] Fill Financial Impact estimates after pricing confirmation
- [ ] Document actual costs vs. estimates
- [ ] Set up cost alerts at predetermined thresholds

## References

- `src/config/index.ts` — Bucket names and `METRICS_RETENTION_DAYS` hint
- `src/services/influxService.ts` — Dual-bucket routing and health check
- `src/storage/influx/BaseInfluxRepo.ts` — `BucketTarget` submit routing
- InfluxDB bucket administration documentation
- Cloud infrastructure cost reporting
