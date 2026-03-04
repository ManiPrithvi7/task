# Instagram Data Fetch Service - Implementation Plan

## 🎯 Objective
Build a Kafka-based consumer service that fetches Instagram metrics for active devices and publishes results to MQTT server for real-time display on physical devices.

## 📋 System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         MQTT Server (24/7)                          │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ • Maintains Redis cache of active devices                    │   │
│  │ • Publishes {deviceId} to "instagram-fetch-requests" topic   │   │
│  │   when device appears in active list                         │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ Kafka Topic
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Instagram Fetch Consumer                          │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ 1. Consumes from "instagram-fetch-requests"                 │   │
│  │ 2. Fetches device social accounts from MongoDB              │   │
│  │ 3. Calls Instagram Graph API with rate limiting             │   │
│  │ 4. Writes metrics to InfluxDB                               │   │
│  │ 5. Publishes results to "instagram-fetch-results"           │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         MQTT Server Consumer                        │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  • Consumes "instagram-fetch-results"                           │   │
│  • Formats data for device display                              │   │
│  • Publishes to proof.mqtt/{deviceId}/instagram                 │   │
│  • Updates device cache with latest metrics                     │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘

                    Data Flow Legend:
                    ─────────────────────────────────
                    Redis:    Active device cache (real-time)
                    MongoDB:  Device config + social accounts
                    InfluxDB: Metrics + audit logs (time-series)
                    Kafka:    Event backbone (durable + ordered)
```

---

## 🔄 Detailed Flow

### 1. Active Device Detection (MQTT Server)
```typescript
// Every X seconds (configurable), MQTT server:
- Scans Redis set "active:devices" for all online devices
- Compares with last published timestamp per device
- For NEW devices or devices with pending updates:
  - Publishes message to Kafka topic "instagram-fetch-requests"
  - Key: deviceId (ensures ordering per device)
  - Value: { deviceId, trigger: "new_connection|scheduled", timestamp }

// On device registration (immediate):
- Device appears in active cache
- Immediately publish to "instagram-fetch-requests"
- No waiting for next scan cycle
```

### 2. Instagram Fetch Consumer (Kafka Consumer Group)
```typescript
Consumer Group: "instagram-fetch-consumers"
Topic: "instagram-fetch-requests" (partitions = 10 for parallelism)
Commit Strategy: After successful API call + InfluxDB write

For each message:
- Extract deviceId from message key
- Look up device in MongoDB:
  - Find social_accounts where platform = "instagram" and deviceId matches
  - Get access_token, instagram_business_account_id, user_id
- Check rate limits:
  - Per-device: 200 calls/hour (Instagram API limit)
  - Global: Track via Redis counters
- Call Instagram Graph API:
  - Endpoint: `/{instagram-business-account-id}/insights`
  - Metrics: follower_count, impressions, reach, profile_views
  - Period: day, week, month (configurable)
- Write to InfluxDB:
  - Measurement: "instagram_metrics"
  - Tags: deviceId, userId, account_id
  - Fields: followers, impressions, reach, views
  - Timestamp: API response time
- Write audit log to InfluxDB:
  - Measurement: "instagram_fetch_audit"
  - Tags: deviceId, status (success/failure)
  - Fields: response_time_ms, error_message (if any)
- Publish result to "instagram-fetch-results" topic
```

### 3. MQTT Publisher Consumer
```typescript
Consumes from: "instagram-fetch-results"
For each result:
- Format payload for device display (see payload structure below)
- Check if device still active in Redis
- If active:
  - Publish to MQTT topic: `proof.mqtt/{deviceId}/instagram`
  - QoS: 1, Retain: false
  - Wait for PUBACK
- If inactive:
  - Store in Redis list `pending:instagram:{deviceId}`
  - Will be sent when device reconnects
```

---

## 📊 Data Structures

### MongoDB Schema (Reference Only - Already Exists)
```typescript
// Social Account Document
{
  _id: ObjectId,
  userId: string,
  deviceId: string,
  platform: "instagram",
  account_type: "business" | "creator",
  access_token: string,          // Encrypted
  token_expires_at: Date,
  instagram_business_account_id: string,
  instagram_username: string,
  refresh_token?: string,
  scopes: string[],
  created_at: Date,
  updated_at: Date
}
```

### Kafka Message — Fetch Request
```typescript
// Topic: instagram-fetch-requests  |  Key: deviceId (for partitioning)
{
  "deviceId": "PROOF-ORD123-B01-DEV456",
  "trigger": "new_connection|scheduled|retry",
  "priority": "high|normal|low",
  "requested_at": "2026-03-04T10:30:00Z",
  "force_refresh": false,
  "metrics": ["followers", "impressions", "reach"]  // optional subset
}
```

### Kafka Message — Fetch Result
```typescript
// Topic: instagram-fetch-results  |  Key: deviceId
{
  "deviceId": "PROOF-ORD123-B01-DEV456",
  "success": true,
  "fetched_at": "2026-03-04T10:30:05Z",
  "data": {
    "followers_count": 15678,
    "followers_delta_24h": 123,
    "impressions_day": 45000,
    "reach_day": 32000,
    "profile_views": 890,
    "media_count": 342
  },
  "metadata": {
    "api_response_time_ms": 450,
    "instagram_account_id": "17841405822304912",
    "cache_hit": false
  }
}
```

### MQTT Payload to Device
```typescript
// Topic: proof.mqtt/{deviceId}/instagram  |  QoS: 1
{
  "version": "1.1",
  "id": `msg_inst_${Date.now()}`,
  "type": "screen_update",
  "screen": "instagram",
  "muted": false,
  "timestamp": "2026-03-04T10:30:06Z",
  "payload": {
    "followers_count": 15678,
    "celebration_type": calculateCelebrationType(15678, previous_count),
    "duration": 15,
    "target": 20000,
    "progress": 78,     // % to next milestone
    "color_palette": "instagram",
    "message": generateMessage(15678),
    "animation": "pulse_grow",
    "flag": false,
    "url": "https://instagram.com/businessprofile"
  }
}
```

---

## ⏱️ Timing & Scheduling Strategy

### Primary Schedule: 1-Minute Fixed Window
Every 60 seconds, for ALL active devices: fetch latest Instagram metrics, write to InfluxDB, and update device displays.

### Option 1: Cron-Based (Simpler)
```typescript
setInterval(async () => {
  const activeDevices = await redis.smembers('active:devices');
  const batches = chunk(activeDevices, BATCH_SIZE);

  for (const batch of batches) {
    await Promise.all(
      batch.map(deviceId =>
        fetchInstagramMetrics(deviceId).catch(e => logError(e))
      )
    );
    await sleep(1000); // smooth API calls between batches
  }
}, 60_000);
```

### Option 2: Kafka Scheduler (More Robust)
A separate scheduler service reads active devices from Redis every minute and publishes scheduled fetch messages to Kafka. Multiple consumers can parallelize, supports exactly-once semantics, retry capability, and no single point of failure.

---

## 🚀 Batch Processing Strategy

```typescript
class InstagramBatchProcessor {
  private readonly BATCH_SIZE = 50;
  private readonly CONCURRENT_BATCHES = 3;

  async processActiveDevices(deviceIds: string[]) {
    const prioritized = await this.prioritizeByTier(deviceIds);
    const batches = this.createBatches(prioritized, this.BATCH_SIZE);

    for (let i = 0; i < batches.length; i += this.CONCURRENT_BATCHES) {
      const concurrentBatches = batches.slice(i, i + this.CONCURRENT_BATCHES);
      await Promise.all(concurrentBatches.map(batch => this.processBatch(batch)));
      await sleep(2000); // cool-down between batch groups
    }
  }

  private async processBatch(batch: string[]) {
    const results = await Promise.allSettled(
      batch.map(deviceId =>
        this.rateLimiter.checkAndExecute(deviceId, () =>
          this.fetchInstagramMetrics(deviceId)
        )
      )
    );

    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') {
        await this.handleFailure(batch[index], result.reason);
      }
    }
  }
}
```

---

## 📈 InfluxDB Schema Design

```typescript
// Measurement: instagram_metrics
{
  measurement: 'instagram_metrics',
  tags: { deviceId, userId, instagramAccountId, accountType },
  fields: {
    followers: 15678,
    followers_delta_24h: 123,
    impressions_day: 45000,
    impressions_week: 310000,
    reach_day: 32000,
    reach_week: 210000,
    profile_views: 890,
    media_count: 342,
    engagement_rate: 2.4
  },
  timestamp: new Date()
}

// Measurement: instagram_fetch_audit
{
  measurement: 'instagram_fetch_audit',
  tags: { deviceId, status: 'success|failure|rate_limited', trigger },
  fields: {
    response_time_ms: 450,
    api_calls_remaining: 150,
    error_code: 400,        // if failure
    error_message: '',      // if failure
    retry_count: 0
  },
  timestamp: new Date()
}
```

---

## 🔐 Rate Limiting & Error Handling

### Multi-Layer Rate Limiter (Redis-Backed)
```typescript
class InstagramRateLimiter {
  async checkAndExecute(deviceId: string, fn: Function) {
    // Layer 1: Global Instagram limit (200 calls/hour)
    const globalKey = `rate_limit:instagram:global:${Math.floor(Date.now() / 3600000)}`;
    const globalCount = await redis.incr(globalKey);
    if (globalCount === 1) await redis.expire(globalKey, 3600);
    if (globalCount > 200) throw new Error('Global Instagram rate limit exceeded');

    // Layer 2: Per-device limit (100 calls/hour)
    const deviceKey = `rate_limit:instagram:device:${deviceId}:${Math.floor(Date.now() / 3600000)}`;
    const deviceCount = await redis.incr(deviceKey);
    if (deviceCount === 1) await redis.expire(deviceKey, 3600);
    if (deviceCount > 100) throw new Error('Device rate limit exceeded');

    // Layer 3: Token bucket for burst control (5 tokens / 5s refill)
    const bucketKey = `token_bucket:instagram:${deviceId}`;
    const tokens = await redis.get(bucketKey);
    if (tokens && parseInt(tokens) < 1) throw new Error('Token bucket empty');
    await redis.decr(bucketKey);
    if (!tokens) await redis.setex(bucketKey, 5, 5);

    return fn();
  }
}
```

### Retry with Exponential Backoff
```typescript
async function fetchWithRetry(deviceId: string, retryCount = 0): Promise<Result> {
  try {
    return await fetchInstagramMetrics(deviceId);
  } catch (error) {
    if (error.code === 4) { // Rate limit
      const delay = Math.pow(2, retryCount) * 1000; // 1s, 2s, 4s, 8s
      await sleep(delay);
      if (retryCount < 3) return fetchWithRetry(deviceId, retryCount + 1);
      // After 3 retries, re-queue for next minute
      await kafkaProducer.send({
        topic: 'instagram-fetch-requests',
        messages: [{ key: deviceId, value: JSON.stringify({ deviceId, trigger: 'retry' }) }]
      });
    }
    await influxService.writeError({ deviceId, error: error.message, retryCount });
  }
}
```

---

## 📦 Implementation Checklist

### Phase 1: Core Infrastructure
- [ ] Create Kafka topics with appropriate partitions
  - `instagram-fetch-requests` (10 partitions)
  - `instagram-fetch-results` (10 partitions)
- [ ] Configure consumer groups with exactly-once semantics
- [ ] Set up Redis for rate limiting and token buckets
- [ ] Verify MongoDB indexes on `social_accounts.deviceId`

### Phase 2: MQTT Server Integration
- [ ] Add Redis `active:devices` set management
- [ ] Implement device registration → immediate fetch trigger
- [ ] Add scheduled scan (every 60s) for all active devices
- [ ] Build Kafka producer for fetch requests

### Phase 3: Instagram Fetch Consumer
- [ ] Create consumer group with 3–5 instances
- [ ] Implement MongoDB lookup for device tokens
- [ ] Add Instagram Graph API client with retry logic
- [ ] Build multi-layer rate limiter (Redis-backed)
- [ ] Write metrics to InfluxDB
- [ ] Publish results to Kafka

### Phase 4: Result Processing
- [ ] Create consumer for fetch results
- [ ] Implement device online check (Redis)
- [ ] Build MQTT publisher with QoS 1
- [ ] Add offline message queuing (Redis lists)
- [ ] Create device display formatter

### Phase 5: Monitoring & Observability
- [ ] InfluxDB dashboards: API response times, success/failure rates, rate limit hits, device metrics trends
- [ ] Prometheus metrics for Kafka consumer lag
- [ ] Alert rules: high error rates (>5%), consumer lag > 1000 messages, rate limit saturation

---

## 🚨 Edge Cases & Solutions

| Edge Case | Solution |
|-----------|----------|
| Device disconnects mid-fetch | Store result in Redis, publish when reconnected |
| Instagram API rate limit hit | Exponential backoff + schedule retry |
| Token expired | Publish to `token-refresh-required` topic |
| New device appears | Immediate fetch (don't wait for next cycle) |
| Consumer crash | Kafka rebalances, exactly-once ensures no data loss |
| Instagram API down | Circuit breaker pattern, fallback to cached data |
| Duplicate fetches | Idempotency keys + deduplication window |
| Batch too large | Dynamic batch sizing based on API response times |

---

## 🎯 Success Metrics

- [ ] **Coverage**: 100% of active devices fetched every minute
- [ ] **Latency**: 95th percentile < 2 seconds from request to device display
- [ ] **Reliability**: 99.9% successful fetches
- [ ] **Data Freshness**: No device shows data > 2 minutes old
- [ ] **Cost Efficiency**: Instagram API calls optimized, minimal waste
