# Redis Cloud Connection Guide

## ✅ Yes, Our Redis Service Supports Redis Cloud!

The Redis service has been enhanced to fully support **Redis Cloud** (and other cloud Redis providers) with TLS/SSL encryption.

---

## 🔧 Connection Methods

### Method 1: Using Redis URL (Recommended for Redis Cloud)

**Redis Cloud provides a connection URL** that includes all authentication details. This is the easiest method.

#### Environment Variable:
```bash
REDIS_ENABLED=true
REDIS_URL=rediss://username:password@host:port
```

**Note:** Use `rediss://` (with double 's') for TLS/SSL connections. Redis Cloud requires TLS.

#### Example Redis Cloud URL:
```bash
REDIS_URL=rediss://default:your-password@redis-12345.c123.us-east-1-1.ec2.cloud.redislabs.com:12345
```

**Format Breakdown:**
- `rediss://` = Protocol with TLS/SSL (required for Redis Cloud)
- `default` = Username (usually "default" for Redis Cloud)
- `your-password` = Your Redis Cloud password
- `redis-12345.c123...` = Redis Cloud hostname
- `12345` = Redis Cloud port (usually 12345 or similar)

---

### Method 2: Using Individual Parameters (with TLS)

If you prefer to set individual parameters instead of a URL:

#### Environment Variables:
```bash
REDIS_ENABLED=true
REDIS_HOST=redis-12345.c123.us-east-1-1.ec2.cloud.redislabs.com
REDIS_PORT=12345
REDIS_USERNAME=default
REDIS_PASSWORD=your-password
REDIS_TLS=true
REDIS_DB=0
```

**Important:** Set `REDIS_TLS=true` when connecting to Redis Cloud.

---

## 📋 Redis Cloud Setup Steps

### Step 1: Get Your Redis Cloud Connection Details

1. Log in to your **Redis Cloud** dashboard
2. Navigate to your database
3. Copy the **Connection String** or **Endpoint URL**
4. Extract:
   - Hostname
   - Port
   - Username (usually "default")
   - Password

### Step 2: Configure Environment Variables

#### Option A: Using URL (Easiest)
```bash
REDIS_ENABLED=true
REDIS_URL=rediss://default:your-password@redis-12345.c123.us-east-1-1.ec2.cloud.redislabs.com:12345
```

#### Option B: Using Individual Parameters
```bash
REDIS_ENABLED=true
REDIS_HOST=redis-12345.c123.us-east-1-1.ec2.cloud.redislabs.com
REDIS_PORT=12345
REDIS_USERNAME=default
REDIS_PASSWORD=your-password
REDIS_TLS=true
```

### Step 3: Deploy

The application will automatically:
- ✅ Detect TLS from `rediss://` URL or `REDIS_TLS=true`
- ✅ Connect securely to Redis Cloud
- ✅ Use Redis for token persistence

---

## 🔍 How It Works

### TLS/SSL Detection

1. **URL-based connection:**
   - `redis://` → No TLS
   - `rediss://` → TLS enabled automatically

2. **Host/Port connection:**
   - `REDIS_TLS=true` → TLS enabled
   - `REDIS_TLS=false` or unset → No TLS

### Connection Flow

```
Application Start
    ↓
Check REDIS_ENABLED
    ↓
Check REDIS_URL or (REDIS_HOST + REDIS_PORT)
    ↓
Detect TLS (rediss:// or REDIS_TLS=true)
    ↓
Create Redis Client with TLS
    ↓
Connect to Redis Cloud
    ↓
✅ Connected (Token Persistence Active)
```

---

## 🧪 Testing the Connection

### Check Logs

When the application starts, you should see:

**Success:**
```
[info] 💾 Initializing Redis (Token Persistence)...
[info] Connecting to Redis using URL {"url":"rediss://***","tls":true}
[info] ✅ Redis connected successfully
```

**Failure:**
```
[info] 💾 Initializing Redis (Token Persistence)...
[error] ❌ Failed to connect to Redis {"error":"..."}
[warn] ⚠️  Provisioning tokens will use in-memory storage
```

### Test Connection Manually

```bash
# Using redis-cli with TLS
redis-cli -h redis-12345.c123.us-east-1-1.ec2.cloud.redislabs.com \
  -p 12345 \
  -a your-password \
  --tls \
  ping
```

Expected response: `PONG`

---

## 🔒 Security Notes

### TLS/SSL Encryption

- ✅ **Redis Cloud requires TLS** - Always use `rediss://` URLs
- ✅ **Passwords are encrypted in transit** - TLS protects credentials
- ✅ **No plaintext connections** - All Redis Cloud traffic is encrypted

### Best Practices

1. **Use Environment Variables** - Never hardcode credentials
2. **Use URL Method** - Simplest and most secure
3. **Rotate Passwords** - Regularly update Redis Cloud passwords
4. **Monitor Connections** - Check Redis Cloud dashboard for active connections

---

## 🚨 Troubleshooting

### Issue: Connection Refused

**Error:**
```
[error] Redis Client Error {"error":"connect ECONNREFUSED"}
```

**Solutions:**
1. Verify `REDIS_URL` or `REDIS_HOST` is correct
2. Check Redis Cloud firewall/whitelist settings
3. Ensure your IP is whitelisted in Redis Cloud
4. Verify port number is correct

---

### Issue: TLS Handshake Failed

**Error:**
```
[error] Redis Client Error {"error":"TLS handshake failed"}
```

**Solutions:**
1. Ensure you're using `rediss://` (not `redis://`)
2. Set `REDIS_TLS=true` if using host/port method
3. Check Redis Cloud TLS settings
4. Verify network allows TLS connections

---

### Issue: Authentication Failed

**Error:**
```
[error] Redis Client Error {"error":"NOAUTH Authentication required"}
```

**Solutions:**
1. Verify `REDIS_PASSWORD` is correct
2. Check `REDIS_USERNAME` (usually "default")
3. Ensure password is URL-encoded in `REDIS_URL` if it contains special characters
4. Verify Redis Cloud user permissions

---

### Issue: Connection Timeout

**Error:**
```
[error] Redis Client Error {"error":"Connection timeout"}
```

**Solutions:**
1. Check network connectivity to Redis Cloud
2. Verify firewall rules allow outbound connections
3. Check Redis Cloud service status
4. Verify hostname resolves correctly

---

## 📊 Supported Redis Cloud Features

✅ **TLS/SSL Encryption** - Fully supported  
✅ **Authentication** - Username/password supported  
✅ **Connection Pooling** - Automatic connection management  
✅ **Token Persistence** - Provisioning tokens stored in Redis  
✅ **Graceful Fallback** - Falls back to in-memory storage if Redis unavailable  

---

## 🔄 Migration from Local Redis

If you're migrating from a local Redis instance to Redis Cloud:

### Before (Local):
```bash
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_TLS=false
```

### After (Redis Cloud):
```bash
REDIS_URL=rediss://default:password@redis-cloud-host:port
# OR
REDIS_HOST=redis-cloud-host
REDIS_PORT=port
REDIS_USERNAME=default
REDIS_PASSWORD=password
REDIS_TLS=true
```

**No code changes required!** Just update environment variables.

---

## 📚 Additional Resources

- [Redis Cloud Documentation](https://docs.redislabs.com/)
- [Redis Cloud Connection Guide](https://docs.redislabs.com/latest/rc/rc-quickstart/)
- [Redis TLS Configuration](https://redis.io/docs/management/security/tls/)

---

## ✅ Summary

**Yes, our Redis service fully supports Redis Cloud!**

- ✅ TLS/SSL encryption (`rediss://` URLs)
- ✅ Username/password authentication
- ✅ Automatic TLS detection
- ✅ Graceful error handling
- ✅ In-memory fallback if Redis unavailable

**Just set your Redis Cloud connection URL and you're ready to go!**

```bash
REDIS_ENABLED=true
REDIS_URL=rediss://default:password@your-redis-cloud-host:port
```

---

**Status:** ✅ **Redis Cloud Ready**
