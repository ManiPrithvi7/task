#!/bin/bash
# Integration test for mqtt-publisher-lite with mqtt-test-client
set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}   MQTT Publisher Lite - Integration Test${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Cleanup function
cleanup() {
    echo ""
    echo -e "${YELLOW}🧹 Cleaning up...${NC}"
    kill $PUBLISHER_PID 2>/dev/null || true
    sleep 2
    echo -e "${GREEN}✅ Cleanup complete${NC}"
}

trap cleanup EXIT

# Step 1: Kill any existing processes
echo -e "${YELLOW}🧹 Cleaning up existing processes...${NC}"
lsof -ti:3002 | xargs kill -9 2>/dev/null || true
sleep 2

# Step 2: Start mqtt-publisher-lite
echo -e "${BLUE}🚀 Starting mqtt-publisher-lite...${NC}"
cd /home/muthuselvan/Desktop/statsMqtt/services/mqtt-publisher-lite
npm start > /tmp/mqtt-publisher-lite-test.log 2>&1 &
PUBLISHER_PID=$!
echo -e "${GREEN}   PID: $PUBLISHER_PID${NC}"

# Step 3: Wait for startup
echo ""
echo -e "${YELLOW}⏳ Waiting for publisher to start (10 seconds)...${NC}"
for i in {1..10}; do
    if curl -s http://localhost:3002/health > /dev/null 2>&1; then
        echo -e "${GREEN}✅ Publisher is ready after $i seconds!${NC}"
        break
    fi
    sleep 1
    if [ $i -eq 10 ]; then
        echo -e "${RED}❌ Publisher failed to start in 10 seconds${NC}"
        echo ""
        echo "Last 20 lines of log:"
        tail -20 /tmp/mqtt-publisher-lite-test.log
        exit 1
    fi
done

# Step 4: Test health endpoint
echo ""
echo -e "${BLUE}📊 Testing health endpoint...${NC}"
HEALTH_RESPONSE=$(curl -s http://localhost:3002/health)
echo "$HEALTH_RESPONSE" | jq
MQTT_CONNECTED=$(echo "$HEALTH_RESPONSE" | jq -r '.mqtt.connected')

if [ "$MQTT_CONNECTED" = "true" ]; then
    echo -e "${GREEN}✅ MQTT connection verified${NC}"
else
    echo -e "${RED}❌ MQTT not connected${NC}"
    exit 1
fi

# Step 5: Register a test device via API
echo ""
echo -e "${BLUE}📱 Registering test device via API...${NC}"
DEVICE_RESPONSE=$(curl -s -X POST http://localhost:3002/api/devices \
  -H "Content-Type: application/json" \
  -d '{
    "deviceId": "TEST-DEVICE-001",
    "clientId": "test-client-001",
    "username": "testuser",
    "metadata": {"firmware": "v1.0.0", "model": "ESP32"}
  }')
echo "$DEVICE_RESPONSE" | jq

if echo "$DEVICE_RESPONSE" | jq -e '.success' > /dev/null; then
    echo -e "${GREEN}✅ Device registered via API${NC}"
else
    echo -e "${RED}❌ Device registration failed${NC}"
fi

# Step 6: Publish MQTT message via API
echo ""
echo -e "${BLUE}📡 Publishing MQTT message via API...${NC}"
PUBLISH_RESPONSE=$(curl -s -X POST http://localhost:3002/api/publish \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "statsnapp/TEST-DEVICE-001/status",
    "payload": {"status": "online", "uptime": 3600},
    "qos": 0,
    "retain": false
  }')
echo "$PUBLISH_RESPONSE" | jq

if echo "$PUBLISH_RESPONSE" | jq -e '.success' > /dev/null; then
    echo -e "${GREEN}✅ MQTT message published${NC}"
else
    echo -e "${RED}❌ MQTT publish failed${NC}"
fi

# Step 7: Wait and check logs
echo ""
echo -e "${BLUE}⏳ Waiting 3 seconds for message processing...${NC}"
sleep 3

# Step 8: Check devices endpoint
echo ""
echo -e "${BLUE}📋 Getting all devices...${NC}"
DEVICES=$(curl -s http://localhost:3002/api/devices)
echo "$DEVICES" | jq
DEVICE_COUNT=$(echo "$DEVICES" | jq '. | length')
echo -e "${GREEN}Total devices: $DEVICE_COUNT${NC}"

# Step 9: Show recent logs
echo ""
echo -e "${BLUE}📄 Recent publisher logs:${NC}"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
tail -30 /tmp/mqtt-publisher-lite-test.log | grep -E "(Device Registration|Device Status|Live Metrics|Milestone|Alert|Subscribed)" || echo "No matching logs found"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

# Step 10: Instructions for manual test
echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}   Now Test with MQTT Test Client${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${YELLOW}Open a new terminal and run:${NC}"
echo ""
echo -e "   ${GREEN}cd services/mqtt-test-client${NC}"
echo -e "   ${GREEN}npm start${NC}"
echo ""
echo -e "${YELLOW}Then watch this terminal for device registration logs!${NC}"
echo ""
echo -e "📊 ${BLUE}To monitor logs in real-time:${NC}"
echo -e "   ${GREEN}tail -f /tmp/mqtt-publisher-lite-test.log${NC}"
echo ""
echo -e "🛑 ${BLUE}To stop this test:${NC}"
echo -e "   ${GREEN}Press Ctrl+C${NC}"
echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${GREEN}Publisher is running and waiting for messages...${NC}"
echo ""

# Follow logs
tail -f /tmp/mqtt-publisher-lite-test.log
