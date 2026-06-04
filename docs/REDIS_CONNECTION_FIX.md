# Redis Connection Fix - Deployment Issue Resolution

## 🐛 Problem

During deployment, Redis connection errors were occurring even when Redis was not configured:

```
2026-02-03T05:49:17.157Z [info] Connecting to Redis {"host":"localhost","port":6379}
2026-02-03T05:49:17.168Z [error] Redis Client Error {"error":"connect ECONNREFUSED ::1:6379"}
2026-02-03T05:49:17.169Z [error] ❌ Failed to connect to Redis
2026-02-03T05:49:17.170Z [error] Failed to disconnect from Redis {"error":"The client is closed"}
```

### Root Causes

1. **Missing Configuration Check**: The code attempted to connect to Redis even when no connection details were provided, defaulting to `localhost:6379`
2. **No Pre-Connection Validation**: `connect()` method didn't check if Redis was configured before attempting connection
3. **Disconnect Error**: When connection failed, the code tried to disconnect from a closed client, causing additional errors

---

## ✅ Solution

### 1. Added `isRedisConfigured()` Method

**File:** `src/services/redisService.ts`

```typescript
/**
 * Check if Redis is configured (has connection details)
 */
isRedisConfigured(): boolean {
  return !!this.config.url || (!!this.config.host && !!this.config.port);
}
```

**Purpose:** Validates that Redis connection details are present before attempting connection.

---

### 2. Added Configuration Check in `connect()` Method

**File:** `src/services/redisService.ts`

```typescript
async connect(): Promise<void> {
  try {
    if (this.isConnected && this.client) {
      logger.info('Redis already connected');
      return;
    }

    // Check if Redis is configured before attempting connection
    if (!this.isRedisConfigured()) {
      logger.warn('Redis is enabled but no connection details provided. Skipping connection.');
      this.isConnected = false;
      return; // Exit early - no connection attempt
    }

    // ... rest of connection logic
  }
}
```

**Purpose:** Prevents connection attempts when Redis is not configured.

---

### 3. Added Configuration Check in `app.ts`

**File:** `src/app.ts`

```typescript
private async initializeRedis(): Promise<void> {
  logger.info('💾 Initializing Redis (Token Persistence)...');

  this.redisService = createRedisService({
    url: this.config.redis.url,
    username: this.config.redis.username,
    password: this.config.redis.password,
    host: this.config.redis.host,
    port: this.config.redis.port,
    db: this.config.redis.db,
    keyPrefix: this.config.redis.keyPrefix
  });

  // Check if Redis is configured before attempting connection
  if (!this.redisService.isRedisConfigured()) {
    logger.warn('⚠️  Redis enabled but no connection details provided. Provisioning tokens will use in-memory storage.');
    logger.warn('   Set REDIS_URL (cloud) or REDIS_HOST (self-hosted) environment variable.');
    logger.warn('   To disable Redis, set REDIS_ENABLED=false');
    this.config.redis.enabled = false; // Explicitly disable Redis in config
    return; // Exit early - no connection attempt
  }

  try {
    await this.redisService.connect();
    // ... success handling
  } catch (error: any) {
    // ... error handling with graceful fallback
  }
}
```

**Purpose:** Validates configuration before creating service and attempting connection.

---

### 4. Fixed `disconnect()` Error Handling

**File:** `src/services/redisService.ts`

```typescript
async disconnect(): Promise<void> {
  try {
    if (!this.client) {
      logger.debug('Redis already disconnected');
      return;
    }

    // Check if client is open before trying to quit
    if (this.client.isOpen) {
      await this.client.quit();
    } else {
      logger.debug('Redis client already closed, skipping quit');
    }
    
    this.client = null;
    this.isConnected = false;

    logger.info('Redis disconnected successfully');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    // Don't throw on disconnect errors - client might already be closed
    logger.debug('Redis disconnect completed (client may have been closed)', { error: errorMessage });
    this.client = null;
    this.isConnected = false;
  }
}
```

**Changes:**
- Check `client.isOpen` before calling `quit()`
- Don't throw errors on disconnect failures
- Gracefully handle already-closed clients

**Purpose:** Prevents "Failed to disconnect" errors when client is already closed.

---

### 5. Updated Config Validation

**File:** `src/config/index.ts`

```typescript
if (config.redis.enabled && !config.redis.url && (!config.redis.host || !config.redis.port)) {
  logger.warn('Redis enabled but no connection details provided. Provisioning tokens will not be persistent.');
  logger.warn('Set REDIS_URL (cloud) or REDIS_HOST + REDIS_PORT (self-hosted) environment variables.');
  logger.warn('To disable Redis, set REDIS_ENABLED=false');
  // Auto-disable Redis if not configured to prevent connection attempts
  config.redis.enabled = false;
}
```

**Changes:**
- Now checks for both `host` AND `port` (not just `host`)
- Matches the logic in `isRedisConfigured()`

**Purpose:** Ensures config validation matches the connection check logic.

---

## 🎯 Behavior After Fix

### When Redis is NOT Configured:

**Before:**
```
[info] Connecting to Redis {"host":"localhost","port":6379}
[error] Redis Client Error {"error":"connect ECONNREFUSED ::1:6379"}
[error] ❌ Failed to connect to Redis
[error] Failed to disconnect from Redis {"error":"The client is closed"}
```

**After:**
```
[info] 💾 Initializing Redis (Token Persistence)...
[warn] ⚠️  Redis enabled but no connection details provided. Provisioning tokens will use in-memory storage.
[warn]    Set REDIS_URL (cloud) or REDIS_HOST (self-hosted) environment variable.
[warn]    To disable Redis, set REDIS_ENABLED=false
```

**Result:** ✅ No connection attempts, no errors, graceful fallback to in-memory storage.

---

### When Redis IS Configured:

**Behavior:** Normal connection flow with proper error handling if connection fails.

---

## 📋 Environment Variables

### To Enable Redis (Cloud):
```bash
REDIS_ENABLED=true
REDIS_URL=redis://username:password@host:port
```

### To Enable Redis (Self-Hosted):
```bash
REDIS_ENABLED=true
REDIS_HOST=your-redis-host
REDIS_PORT=6379
REDIS_USERNAME=default
REDIS_PASSWORD=your-password
```

### To Disable Redis:
```bash
REDIS_ENABLED=false
```

**Note:** If `REDIS_ENABLED` is not set, Redis is enabled by default but will gracefully fall back to in-memory storage if not configured.

---

## ✅ Testing

1. **Without Redis Configuration:**
   - App should start without connection errors
   - Should log warnings about missing configuration
   - Should use in-memory token storage

2. **With Redis Configuration:**
   - App should connect to Redis successfully
   - Should use Redis for token persistence

3. **With Invalid Redis Configuration:**
   - App should attempt connection
   - Should handle connection failure gracefully
   - Should fall back to in-memory storage
   - Should not throw disconnect errors

---

## 🔍 Files Modified

1. `src/services/redisService.ts`
   - Added `isRedisConfigured()` method
   - Added configuration check in `connect()`
   - Fixed `disconnect()` error handling

2. `src/app.ts`
   - Added configuration check before connection attempt
   - Improved error handling and logging

3. `src/config/index.ts`
   - Updated validation to check both `host` and `port`

---

## 🎉 Result

- ✅ No connection attempts when Redis is not configured
- ✅ No "Failed to disconnect" errors
- ✅ Graceful fallback to in-memory storage
- ✅ Clear warning messages for operators
- ✅ Application starts successfully without Redis

---

**Status:** ✅ **FIXED** - Ready for deployment
