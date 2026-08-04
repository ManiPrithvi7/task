# InfluxDB Flux Partner Migration Guide

## correlation_id: tag → field (dual-write window)

During v2.3.x–v2.4.x, `correlation_id` is written as **both** a tag and a field on:

- `instagram_fetch_audit`
- `mqtt_delivery`

Partner integrations that filter on the tag can continue using the pre-pivot pattern:

```flux
from(bucket: "metrics")
  |> range(start: -7d)
  |> filter(fn: (r) => r._measurement == "instagram_fetch_audit")
  |> filter(fn: (r) => r.correlation_id == "your-uuid-here")
```

After v2.5.0 (tag removal), use pivot-then-filter on the field:

```flux
from(bucket: "metrics")
  |> range(start: -7d)
  |> filter(fn: (r) => r._measurement == "instagram_fetch_audit")
  |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
  |> filter(fn: (r) => r.correlation_id == "your-uuid-here")
```

## PKI audit verification

Do **not** recompute `pki_audit` hashes from individual tags/fields. Always verify using the stored preimage:

```typescript
sha256(entry.hash_preimage) === entry.hash
```

For CA-level events, `device_id` tag is `"system"` and matches `deviceId` inside `hash_preimage` for entries written after the deviceId consistency fix.
