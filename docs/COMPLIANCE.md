# InfluxDB Retention Compliance Documentation

## Executive Summary

The InfluxDB Metrics retention policy is **not enforced by application code** and is currently an administrative setting in the InfluxDB service. The application documents a default retention period of 30 days as a suggestion, but actual retention is controlled through InfluxDB bucket-level configuration.

## Current State

### Application Configuration

- `METRICS_RETENTION_DAYS` - Default 30 (configurable via `.env`)
- Source: `src/config/index.ts:59`
- Usage: "Reserved hint" for operational guidance only

### Actual Retention Mechanism

InfluxDB retention is configured administratively:

- **Primary Control:** InfluxDB bucket retention policies
- **Applied by:** InfluxDB service administrators
- **Configuration Tool:** InfluxDB API/CLI (not through this application)

### What the Application Writes

The application writes metrics to InfluxDB for the following purposes:

| Metric Category | Frequency | Purpose |
|-----------------|-----------|---------|
| **Device Connections** | 1s (real-time) | Track active/inactive device count |
| **OTA Events** | ~2s intervals | Firmware download/upgrade metrics |
| **Certificate Operations** | ~1s intervals | CSR signing, revocation, recovery |
| **GMB Social** | ~5s intervals | Google Business profile sync |
| **Device Status** | ~10s intervals | Health and status monitoring |

## Retention Policy Details

### Proposed Retention Periods

| Component | Suggested Days | Rationale |
|-----------|----------------|-----------|
| **Device Activity** | 30 | Standard industry practice |
| **OTA Events** | 90 | Auditing needs longer than device data |
| **Certificate Operations** | 180 | Compliance requirements |
| **Audit Logs** | 90 | Investigation requirements |

### Implementation Note

- **Current:** Single bucket with uniform retention
- **Reality:** Only one retention policy applies to all metrics
- **Reality:** Retention is enforced by InfluxDB bucket settings, not application code

## Compliance Considerations

### Regulatory Requirements

| Regulation | Requirement | Compliance Status |
|------------|-------------|-------------------|
| **GDPR** | Data minimization | Not applicable to metrics |
| **SOX** | Audit trail retention | 90-180 days requirement gap |
| **HIPAA** | Protected health info storage | No PHI in metrics |
| **Privacy Act** | Data retention periods | Gap in current implementation |

### Data Loss Risks

The current approach carries these risks:

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

The current approach is **functional but imperfect**. The application provides guidance through configuration but delegates actual enforcement to InfluxDB administration.

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

- `src/config/index.ts:20,59` - Configuration documentation
- InfluxDB bucket administration documentation
- Cloud infrastructure cost reporting
