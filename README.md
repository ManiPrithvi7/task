# 🚀 MQTT Publisher Lite

**Lightweight MQTT Publisher for Firmware Testing** - No external dependencies (Redis, Kafka, InfluxDB)!

## ✨ Features

- ✅ **Zero External Dependencies** - Just Node.js
- ✅ **File-Based Storage** - All data in simple JSON files
- ✅ **Fast Startup** - Ready in 2-3 seconds
- ✅ **Small Footprint** - ~50MB RAM usage
- ✅ **Public MQTT Broker** - Uses broker.emqx.io (no hosting needed)
- ✅ **HTTP API** - Full REST API for device/session management
- ✅ **WebSocket Support** - Real-time MQTT message streaming
- ✅ **Docker Ready** - Single container deployment
- ✅ **Perfect for Testing** - Ideal for firmware development

---

## 📋 Quick Start

### 1. Install Dependencies
```bash
cd services/mqtt-publisher-lite
npm install
```

### 2. Configure
```bash
cp .env.example .env
# Edit .env if needed (defaults work out of the box)
```

### 3. Run
```bash
# Development mode
npm run dev

# Production mode
npm run build
npm start
```

### 4. Test
```bash
# Run automated tests
npm test

# Or manually test
curl http://localhost:3002/health
```

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────┐
│  MQTT Publisher Lite                    │
│                                         │
│  ┌──────────────────────────────────┐  │
│  │  HTTP API (Express)              │  │
│  │  - /health                        │  │
│  │  - /api/sessions                 │  │
│  │  - /api/devices                  │  │
│  │  - /api/users                    │  │
│  │  - /api/publish                  │  │
│  └──────────────────────────────────┘  │
│                                         │
│  ┌──────────────────────────────────┐  │
│  │  WebSocket Server                │  │
│  │  - /ws                           │  │
│  └──────────────────────────────────┘  │
│                                         │
│  ┌──────────────────────────────────┐  │
│  │  MQTT Client                     │  │
│  │  → broker.emqx.io:1883          │  │
│  └──────────────────────────────────┘  │
│                                         │
│  ┌──────────────────────────────────┐  │
│  │  File Storage                    │  │
│  │  - sessions.json                 │  │
│  │  - devices.json                  │  │
│  │  - users.json                    │  │
│  └──────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

---

## 📡 API Endpoints

### Health Check
```bash
GET /health
```

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "mqtt": { "connected": true },
  "storage": {
    "sessions": 5,
    "devices": 10,
    "users": 3
  }
}
```

### Create Session
```bash
POST /api/sessions
Content-Type: application/json

{
  "clientId": "device-001",
  "active_account": "user@example.com",
  "social_accounts": [],
  "access_token": "token-123",
  "createdAt": "2024-01-01T00:00:00.000Z",
  "expiresAt": "2024-01-02T00:00:00.000Z"
}
```

### Register Device
```bash
POST /api/devices
Content-Type: application/json

{
  "deviceId": "device-001",
  "clientId": "client-001",
  "username": "testuser",
  "metadata": {
    "firmware": "v1.0.0",
    "model": "ESP32"
  }
}
```

### Publish MQTT Message
```bash
POST /api/publish
Content-Type: application/json

{
  "topic": "devices/test/status",
  "payload": {"status": "online"},
  "qos": 0,
  "retain": false
}
```

### Get All Devices
```bash
GET /api/devices
```

### Create User
```bash
POST /api/users
Content-Type: application/json

{
  "userId": "user-001",
  "username": "testuser",
  "email": "test@example.com"
}
```

---

## 🔌 WebSocket API

### Connect
```javascript
const ws = new WebSocket('ws://localhost:3002/ws');

ws.onopen = () => {
  console.log('Connected');
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('Message:', data);
};
```

### Subscribe to Topic
```javascript
ws.send(JSON.stringify({
  type: 'subscribe',
  topic: 'devices/+/status'
}));
```

### Publish Message
```javascript
ws.send(JSON.stringify({
  type: 'publish',
  topic: 'devices/test/command',
  payload: { command: 'restart' },
  qos: 0
}));
```

### Ping/Pong
```javascript
ws.send(JSON.stringify({ type: 'ping' }));
// Receives: { type: 'pong', timestamp: '...' }
```

---

## 📂 File Storage

All data is stored in `./data/` directory as JSON files:

### sessions.json
```json
{
  "session:device-001:1234567890": {
    "clientId": "device-001",
    "active_account": "user@example.com",
    "social_accounts": [],
    "access_token": "token-123",
    "createdAt": "2024-01-01T00:00:00.000Z",
    "expiresAt": "2024-01-02T00:00:00.000Z"
  }
}
```

### devices.json
```json
{
  "device-001": {
    "deviceId": "device-001",
    "clientId": "client-001",
    "username": "testuser",
    "status": "active",
    "lastSeen": "2024-01-01T00:00:00.000Z",
    "metadata": {
      "firmware": "v1.0.0"
    }
  }
}
```

### users.json
```json
{
  "user-001": {
    "userId": "user-001",
    "username": "testuser",
    "email": "test@example.com",
    "devices": ["device-001", "device-002"],
    "createdAt": "2024-01-01T00:00:00.000Z"
  }
}
```

---

## 🐳 Docker Usage

### Build
```bash
docker build -t mqtt-publisher-lite .
```

### Run
```bash
docker run -p 3002:3002 \
  -v $(pwd)/data:/app/data \
  -e MQTT_BROKER=broker.emqx.io \
  -e LOG_LEVEL=debug \
  mqtt-publisher-lite
```

### Docker Compose
```yaml
version: '3.8'
services:
  mqtt-publisher-lite:
    build: .
    ports:
      - "3002:3002"
    volumes:
      - ./data:/app/data
    environment:
      - MQTT_BROKER=broker.emqx.io
      - MQTT_PORT=1883
      - HTTP_PORT=3002
      - LOG_LEVEL=info
```

---

## 🧪 Testing

### Run Tests
```bash
npm test
```

### Manual Testing

#### Test MQTT Connection
```bash
# Subscribe to test topic
mosquitto_sub -h broker.emqx.io -t "firmware-dev/#" -v

# Publish via API
curl -X POST http://localhost:3002/api/publish \
  -H "Content-Type: application/json" \
  -d '{"topic":"test/hello","payload":{"msg":"hello"},"qos":0}'
```

#### Test WebSocket
```bash
# Using wscat
npm install -g wscat
wscat -c ws://localhost:3002/ws

# Subscribe to topic
> {"type":"subscribe","topic":"devices/+/status"}

# Publish message
> {"type":"publish","topic":"devices/test/status","payload":{"online":true}}
```

---

## 🔧 Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MQTT_BROKER` | `broker.emqx.io` | MQTT broker hostname |
| `MQTT_PORT` | `1883` | MQTT broker port |
| `MQTT_CLIENT_ID` | `firmware-test-lite` | MQTT client ID |
| `MQTT_TOPIC_PREFIX` | `firmware-dev` | Topic prefix for all messages |
| `HTTP_PORT` | `3002` | HTTP server port |
| `HTTP_HOST` | `0.0.0.0` | HTTP server host |
| `NODE_ENV` | `development` | Environment (development/production) |
| `LOG_LEVEL` | `debug` | Log level (debug/info/warn/error) |
| `DATA_DIR` | `./data` | Data directory for JSON files |
| `SESSION_TTL` | `86400` | Session TTL in seconds (24h) |
| `DEVICE_CLEANUP_INTERVAL` | `3600` | Device cleanup interval in seconds (1h) |

---

## 📊 Comparison with Full Version

| Feature | Full Version | Lite Version |
|---------|--------------|--------------|
| **Dependencies** | Redis, Kafka, InfluxDB, MongoDB | None |
| **Storage** | Distributed databases | Local JSON files |
| **Memory** | ~300MB | ~50MB |
| **Startup Time** | 30-60s | 2-3s |
| **Docker Image** | ~500MB | ~150MB |
| **Scalability** | High (multi-instance) | Low (single instance) |
| **Data Persistence** | High availability | Local only |
| **Best For** | Production | Development/Testing |

---

## 🎯 Use Cases

✅ **Perfect For:**
- Firmware development and testing
- IoT device prototyping
- Quick MQTT testing
- Local development
- CI/CD testing pipelines
- Educational purposes

❌ **Not Recommended For:**
- Production workloads
- High availability requirements
- Multi-instance deployments
- Large-scale data storage
- Distributed systems

---

## 🐛 Troubleshooting

### Can't connect to MQTT broker
```bash
# Test broker connectivity
telnet broker.emqx.io 1883

# Or use mosquitto
mosquitto_pub -h broker.emqx.io -t "test" -m "hello"
```

### Port 3002 already in use
```bash
# Change port in .env
HTTP_PORT=3003

# Or stop existing process
lsof -ti:3002 | xargs kill
```

### Data not persisting
- Check `data/` directory exists and has write permissions
- Verify `DATA_DIR` environment variable
- Check disk space

### MQTT messages not received
- Verify broker connection: Check `/health` endpoint
- Check topic prefix matches
- Verify QoS levels

---

## 📝 Development

### Project Structure
```
mqtt-publisher-lite/
├── src/
│   ├── config/           # Configuration
│   ├── servers/          # HTTP, WebSocket, MQTT
│   ├── storage/          # File-based storage
│   ├── services/         # Business logic (if needed)
│   ├── types/            # TypeScript types
│   ├── utils/            # Utilities (logger, etc.)
│   ├── app.ts            # Main application
│   └── index.ts          # Entry point
├── data/                 # JSON data files (gitignored)
├── dist/                 # Compiled output
├── Dockerfile            # Docker configuration
├── package.json          # Dependencies
├── tsconfig.json         # TypeScript config
└── README.md             # This file
```

### Add New Functionality
1. Add types in `src/types/`
2. Create storage handler in `src/storage/`
3. Add HTTP endpoints in `src/servers/httpServer.ts`
4. Update app orchestrator in `src/app.ts`

---

## 📄 License

MIT License

---

## 🤝 Support

For issues or questions:
1. Check this README
2. Review logs: `npm run dev`
3. Test connectivity: `npm test`
4. Check data files in `./data/`

---

**Happy Firmware Testing! 🎯**
