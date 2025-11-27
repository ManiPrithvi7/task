# Connection Test Instructions

## ✅ Redis Cloud - Already Tested

Your Redis Labs instance is **WORKING** ✓
- Host: redis-15173.crce179.ap-south-1-1.ec2.cloud.redislabs.com
- Port: 15173
- Region: Mumbai (ap-south-1)
- Version: Redis 8.2.1
- Status: Connected successfully!

---

## ⏳ MongoDB Cloud - Setup Required

To test MongoDB connection, you need to provide your MongoDB connection string.

### Step 1: Set MongoDB URI

Choose one of these options:

#### Option A: MongoDB Atlas (Cloud)
```bash
export MONGODB_URI="mongodb+srv://username:password@cluster.mongodb.net/statsmqtt?retryWrites=true&w=majority"
```

#### Option B: Local MongoDB
```bash
export MONGODB_URI="mongodb://localhost:27017/statsmqtt"
```

#### Option C: Docker MongoDB
```bash
export MONGODB_URI="mongodb://root:password@localhost:27017/statsmqtt?authSource=admin"
```

### Step 2: Set Redis Credentials
```bash
export REDIS_USERNAME=default
export REDIS_PASSWORD=vIYPgMldPxNUEd3qJv8TekxSMYVRz51G
export REDIS_HOST=redis-15173.crce179.ap-south-1-1.ec2.cloud.redislabs.com
export REDIS_PORT=15173
```

### Step 3: Run Connection Test
```bash
npx ts-node test-connections.ts
```

### Expected Output (Success)
```
🗃️  Testing MongoDB Connection...
✅ MongoDB Connected Successfully!
⏱️  Connection Time: 234ms
📊 Collections Found: 5

💾 Testing Redis Connection...
✅ Redis Connected Successfully!
⏱️  Connection Time: 952ms
🏓 Ping Response: PONG

📊 Test Summary
MongoDB: ✅ PASS
Redis:   ✅ PASS

🎉 All connections successful! Ready for production.
```

---

## 🚀 Start Application

Once both connections are tested, start your application:

```bash
# All environment variables set above, then:
npm run dev
```

### Expected Output
```
🗃️  MongoDB: Connected (statsmqtt)
💾 Redis: Connected (Token Persistence)
🔐 Provisioning API: http://0.0.0.0:3002/api/v1/onboarding (Redis)
Ready for firmware testing! 🎯
```

---

## 📊 Current Status

| Service | Status | Details |
|---------|--------|---------|
| **Redis** | ✅ **WORKING** | Mumbai, 952ms latency |
| **MongoDB** | ⏳ **NEEDS URI** | Waiting for your credentials |

---

