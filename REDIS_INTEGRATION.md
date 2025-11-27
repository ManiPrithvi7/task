# Redis Integration for Persistent Token Storage

## 🎯 Overview

**Redis cloud-based persistence** has been successfully integrated into `mqtt-publisher-lite` to store provisioning tokens persistently. This replaces the in-memory token storage with cloud Redis for production-ready deployments.

---

## 📊 Changes Summary

### Files Created (1)
```
✅ src/services/redisService.ts - Redis connection management
```

### Files Modified (4)
```
📝 src/storage/tokenStore.ts     - Now uses Redis instead of in-memory
📝 src/config/index.ts            - Added Redis configuration
📝 src/app.ts                     - Initializes Redis service
📝 package.json                   - Added ioredis dependency
```

---

## 🏗️ Architecture

### Before (In-Memory)
```
┌─────────────────────────────────┐
│    Provisioning Tokens          │
├─────────────────────────────────┤
│  • Stored in memory (Map)       │
│  • Lost on restart               │
│  • Not shared across instances   │
└─────────────────────────────────┘
```

### After (Redis Cloud)
```
┌─────────────────────────────────┐
│    Provisioning Tokens          │
├─────────────────────────────────┤
│  • Stored in Redis               │
│  • Persistent across restarts    │
│  • Shared across instances       │
│  • TTL handled by Redis          │
└─────────────────────────────────┘
              ↓
    ┌──────────────────┐
    │   Redis Cloud    │
    │  (Persistent)    │
    └──────────────────┘
```

---

## 🔧 Configuration

### Environment Variables

#### Cloud Redis - Individual Parameters (Recommended)
```bash
# Redis Cloud credentials (from your Redis Labs dashboard)
REDIS_USERNAME=default
REDIS_PASSWORD=vIYPgMldPxNUEd3qJv8TekxSMYVRz51G
REDIS_HOST=redis-15173.crce179.ap-south-1-1.ec2.cloud.redislabs.com
REDIS_PORT=15173
REDIS_DB=0
```

#### Cloud Redis - URL Format (Alternative)
```bash
# Full Redis URL (includes all connection details)
REDIS_URL=redis://default:password@redis-15173.crce179.ap-south-1-1.ec2.cloud.redislabs.com:15173

# Or using rediss:// for TLS
REDIS_URL=rediss://default:password@redis-cloud.com:15173
```

#### Self-Hosted Redis
```bash
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=your-password
REDIS_DB=0
```

#### Optional Settings
```bash
REDIS_ENABLED=true             # Default: true
REDIS_KEY_PREFIX=mqtt-lite:    # Default: mqtt-lite:
```

---

## 🚀 Usage

### With Cloud Redis (Production)
```bash
# 1. Get Redis credentials from your cloud provider
#    Redis Labs: https://redis.com/try-free/

# 2. Set environment variables (from your Redis Labs dashboard)
export REDIS_USERNAME=default
export REDIS_PASSWORD=vIYPgMldPxNUEd3qJv8TekxSMYVRz51G
export REDIS_HOST=redis-15173.crce179.ap-south-1-1.ec2.cloud.redislabs.com
export REDIS_PORT=15173

# 3. Start application
npm run dev
```

**Expected Output**:
```
💾 Initializing Redis (Token Persistence)...
✅ Redis connected successfully
🔐 Provisioning API: http://0.0.0.0:3002/api/v1/onboarding (Redis)
```

### Without Redis (Development)
```bash
# Redis is optional - app will use in-memory fallback
export REDIS_ENABLED=false

npm run dev
```

**Expected Output**:
```
🔐 Provisioning API: http://0.0.0.0:3002/api/v1/onboarding (In-Memory)
⚠️  Provisioning tokens will not be persistent
```

---

## 📝 Token Storage Details

### Redis Keys Structure
```
mqtt-lite:token:eyJhbGci...    → {"deviceId":"device-001","token":"...","expiresAt":1234567890}
mqtt-lite:device:device-001    → eyJhbGci...
```

### TTL Behavior
- Tokens automatically expire via Redis TTL
- Default TTL: 300 seconds (5 minutes)
- Configurable via `PROVISIONING_TOKEN_TTL`

### Key Prefix
- Default: `mqtt-lite:`
- Prevents conflicts with other Redis data
- Customizable via `REDIS_KEY_PREFIX`

---

## 🎨 Features

### ✅ Persistent Storage
- Tokens survive application restarts
- Shared across multiple application instances
- Ideal for production deployments

### ✅ Automatic Expiration
- Redis TTL handles token expiration
- No manual cleanup required
- Memory efficient

### ✅ Cloud-Ready
- Works with any Redis cloud provider
- TLS support for secure connections
- Connection pooling and retry logic

### ✅ Graceful Fallback
- If Redis unavailable, uses in-memory storage
- Application continues to function
- Warning logged for visibility

---

## 🔍 API Operations

### Issue Token
```bash
curl -X POST http://localhost:3002/api/v1/onboarding \
  -H "Content-Type: application/json" \
  -d '{"device_id":"device-001"}'
```

**Response**:
```json
{
  "success": true,
  "provisioning_token": "eyJhbGci...",
  "expires_in": 300,
  "timestamp": "2025-11-27T10:00:00.000Z"
}
```

**Redis Storage**:
```
SET mqtt-lite:token:eyJhbGci... '{"deviceId":"device-001",...}' EX 300
SET mqtt-lite:device:device-001 'eyJhbGci...' EX 300
```

### Verify Token
```bash
curl -X POST http://localhost:3002/api/v1/sign-csr \
  -H "Authorization: Bearer eyJhbGci..." \
  -H "Content-Type: application/json" \
  -d '{"device_id":"device-001","csr":"..."}'
```

**Redis Lookup**:
```
GET mqtt-lite:token:eyJhbGci...  → Returns device details if valid
```

### Token Revocation
- Tokens deleted from Redis after use
- Device can only use token once
- Prevents replay attacks

---

## 📊 Monitoring

### Health Check
```bash
curl http://localhost:3002/health
```

**Response** (with Redis):
```json
{
  "status": "ok",
  "redis": {
    "connected": true,
    "tokenCount": 5,
    "deviceCount": 5
  }
}
```

### Redis Statistics
```typescript
// Available via TokenStore
const stats = await tokenStore.getStats();
// {
//   tokenCount: 5,
//   deviceCount: 5,
//   connected: true
// }
```

---

## 🛡️ Security

### TLS Support
```bash
# Use rediss:// protocol for TLS
REDIS_URL=rediss://user:password@redis-cloud.com:6379

# Or set TLS flag
REDIS_TLS=true
```

### Password Authentication
```bash
# Included in URL
REDIS_URL=redis://user:password@host:6379

# Or separate
REDIS_PASSWORD=your-secure-password
```

### Key Isolation
- All keys prefixed with `mqtt-lite:`
- Prevents conflicts with other applications
- Customizable prefix for multi-tenancy

---

## 🔧 Troubleshooting

### Problem: Cannot connect to Redis
**Error**: `Failed to connect to Redis: connect ECONNREFUSED`

**Solutions**:
1. Check Redis is running
2. Verify `REDIS_URL` or `REDIS_HOST`
3. Check firewall rules
4. Verify credentials

**Fallback**: App continues with in-memory storage

### Problem: Tokens not persisting
**Check**:
```bash
# Verify Redis connection
redis-cli PING

# Check keys
redis-cli KEYS "mqtt-lite:*"

# Check TTL
redis-cli TTL "mqtt-lite:token:eyJhbGci..."
```

### Problem: Connection timeout
**Solution**: Increase timeout or check network
```bash
# Check Redis connectivity
redis-cli -h your-redis-cloud.com -p 6379 PING
```

---

## 📦 Cloud Redis Providers

### Redis Labs (Recommended)
```bash
# Free tier: 30MB storage
# https://redis.com/try-free/

# Get these from your Redis Labs dashboard:
REDIS_USERNAME=default
REDIS_PASSWORD=vIYPgMldPxNUEd3qJv8TekxSMYVRz51G
REDIS_HOST=redis-15173.crce179.ap-south-1-1.ec2.cloud.redislabs.com
REDIS_PORT=15173

# Or use URL format:
REDIS_URL=redis://default:vIYPgMldPxNUEd3qJv8TekxSMYVRz51G@redis-15173.crce179.ap-south-1-1.ec2.cloud.redislabs.com:15173
```

### AWS ElastiCache
```bash
# Use primary endpoint
REDIS_HOST=my-cluster.abc123.0001.use1.cache.amazonaws.com
REDIS_PORT=6379
REDIS_TLS=true
```

### Azure Cache for Redis
```bash
# Use connection string
REDIS_URL=rediss://default:password@myredis.redis.cache.windows.net:6380
```

### Google Cloud Memorystore
```bash
REDIS_HOST=10.0.0.3  # VPC internal IP
REDIS_PORT=6379
```

---

## 🧪 Testing

### Build Test
```bash
npm run build
# ✅ TypeScript compilation successful
```

### Runtime Test (with Redis)
```bash
export REDIS_URL="redis://localhost:6379"
npm run dev
# ✅ Redis connected successfully
```

### Runtime Test (without Redis)
```bash
export REDIS_ENABLED=false
npm run dev
# ⚠️  Provisioning tokens will not be persistent
```

---

## 📈 Benefits

### Production Ready
- ✅ Persistent storage across restarts
- ✅ Horizontal scaling support
- ✅ Automatic expiration handling
- ✅ Cloud-native architecture

### Developer Friendly
- ✅ Optional (graceful fallback)
- ✅ Easy configuration
- ✅ Clear error messages
- ✅ Comprehensive logging

### Performance
- ✅ Fast in-memory operations
- ✅ Efficient TTL handling
- ✅ Connection pooling
- ✅ Automatic retry logic

---

## 🎯 Comparison

| Feature | In-Memory (Old) | Redis (New) |
|---------|----------------|-------------|
| **Persistence** | ❌ Lost on restart | ✅ Persistent |
| **Multi-Instance** | ❌ Separate stores | ✅ Shared |
| **Scalability** | ❌ Single node only | ✅ Horizontal scaling |
| **TTL** | Manual cleanup | ✅ Automatic |
| **Production Ready** | ❌ Development only | ✅ Yes |
| **Cloud Native** | ❌ No | ✅ Yes |

---

## 🔄 Migration Path

### From In-Memory to Redis
1. Deploy Redis (cloud or self-hosted)
2. Set `REDIS_URL` environment variable
3. Restart application
4. Tokens now persisted in Redis

### No Breaking Changes
- API endpoints unchanged
- Token format unchanged
- Same JWT structure
- Backward compatible

---

## 📚 Related Documentation

- **MONGODB_INTEGRATION.md** - MongoDB setup
- **MONGODB_MIGRATION.md** - Migration from file storage
- **IMPLEMENTATION_SUMMARY.md** - Overall architecture

---

## 🎯 Summary

**Status**: ✅ **COMPLETE**  
**Build**: ✅ **PASSING**  
**Production Ready**: ✅ **YES**  

Redis integration provides **production-grade persistent storage** for provisioning tokens while maintaining **backward compatibility** with in-memory fallback for development.

---

**Integration Date**: November 27, 2025  
**Version**: 1.1.0  
**Status**: Production Ready

---

**End of Redis Integration Document**

