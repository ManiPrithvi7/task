# 🚀 Quick Start Guide - MQTT Publisher Lite

## ⚡ 30-Second Setup

```bash
cd services/mqtt-publisher-lite
chmod +x start.sh
./start.sh
```

That's it! The service will be running at `http://localhost:3002`

---

## 📝 What This Does

1. Connects to public MQTT broker (`broker.emqx.io`)
2. Starts HTTP API on port 3002
3. Starts WebSocket server on `/ws`
4. Creates local JSON files for data storage

---

## 🧪 Test It Works

### 1. Check Health
```bash
curl http://localhost:3002/health
```

### 2. Publish MQTT Message
```bash
curl -X POST http://localhost:3002/api/publish \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "test/hello",
    "payload": {"message": "Hello World!"},
    "qos": 0
  }'
```

### 3. Subscribe with Mosquitto
```bash
# In another terminal
mosquitto_sub -h broker.emqx.io -t "firmware-dev/#" -v
```

### 4. Register a Device
```bash
curl -X POST http://localhost:3002/api/devices \
  -H "Content-Type: application/json" \
  -d '{
    "deviceId": "device-001",
    "clientId": "client-001",
    "username": "testuser",
    "metadata": {"firmware": "v1.0.0"}
  }'
```

### 5. Get All Devices
```bash
curl http://localhost:3002/api/devices | jq
```

---

## 📂 Check Your Data

All data is stored as JSON files:

```bash
# View sessions
cat data/sessions.json | jq

# View devices
cat data/devices.json | jq

# View users
cat data/users.json | jq
```

---

## 🛑 Stop the Service

Press `Ctrl+C` in the terminal where it's running.

---

## 🔧 Customize

Edit `.env` file:

```bash
# Change MQTT broker
MQTT_BROKER=test.mosquitto.org

# Change HTTP port
HTTP_PORT=3003

# Change log level
LOG_LEVEL=info
```

Then restart:
```bash
./start.sh
```

---

## 🐛 Troubleshooting

### Port 3002 in use?
```bash
# Kill existing process
lsof -ti:3002 | xargs kill

# Or change port in .env
echo "HTTP_PORT=3003" >> .env
```

### Can't connect to MQTT broker?
```bash
# Test broker directly
mosquitto_pub -h broker.emqx.io -t "test" -m "hello"

# If that fails, broker might be down. Try alternative:
echo "MQTT_BROKER=test.mosquitto.org" >> .env
```

### Data not saving?
```bash
# Check data directory exists and is writable
ls -la data/
chmod 777 data/
```

---

## 📚 Next Steps

1. Read full [README.md](./README.md) for all API endpoints
2. Check [API examples](./README.md#-api-endpoints)
3. Try [WebSocket examples](./README.md#-websocket-api)
4. Build your firmware test scenarios!

---

**You're ready to test your firmware! 🎯**
