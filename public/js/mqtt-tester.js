// MQTT Publisher Lite - Testing Interface Client

class MQTTTester {
  constructor() {
    this.baseURL = window.location.origin;
    this.ws = null;
    this.monitorPaused = false;
    this.messageHistory = [];
    this.maxMessages = 100;
    
    this.init();
  }

  init() {
    // Initialize UI
    this.setupEventListeners();
    this.loadDevices();
    this.checkServerStatus();
    this.connectWebSocket();
    
    // Auto-refresh devices every 10 seconds
    setInterval(() => this.loadDevices(), 10000);
    
    // Update topic preview on change
    document.getElementById('custom-deviceId').addEventListener('input', () => this.updateTopicPreview());
    document.getElementById('messageType').addEventListener('change', () => this.updateTopicPreview());
  }

  setupEventListeners() {
    // Registration form
    document.getElementById('registration-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.registerDevice();
    });

    // Unregister button
    document.getElementById('unregister-btn').addEventListener('click', () => {
      this.unregisterDevice();
    });

    // Generate ID button
    document.getElementById('generate-id-btn').addEventListener('click', () => {
      this.generateDeviceId();
    });

    // Custom message form
    document.getElementById('custom-message-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.publishCustomMessage();
    });

    // Refresh devices button
    document.getElementById('refresh-devices-btn').addEventListener('click', () => {
      this.loadDevices();
    });

    // Clear monitor button
    document.getElementById('clear-monitor-btn').addEventListener('click', () => {
      this.clearMonitor();
    });

    // Toggle monitor button
    document.getElementById('toggle-monitor-btn').addEventListener('click', () => {
      this.toggleMonitor();
    });

    // Device filter
    document.getElementById('device-filter').addEventListener('change', () => {
      this.filterMessages();
    });
  }

  // API Methods
  async registerDevice() {
    const deviceId = document.getElementById('deviceId').value;
    const userId = document.getElementById('userId').value;
    const deviceType = document.getElementById('deviceType').value;
    const os = document.getElementById('os').value;
    const appVersion = document.getElementById('appVersion').value;

    try {
      const response = await fetch(`${this.baseURL}/api/test/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, userId, deviceType, os, appVersion })
      });

      const data = await response.json();

      if (data.success) {
        this.showToast('success', `✅ Device registered: ${deviceId}`);
        this.addMonitorMessage('success', 'Registration Published', 
          `Device: ${deviceId}\nTopic: ${data.topic}\nWaiting for server confirmation...`);
        this.loadDevices();
      } else {
        this.showToast('error', `❌ Registration failed: ${data.error}`);
      }
    } catch (error) {
      this.showToast('error', `❌ Error: ${error.message}`);
    }
  }

  async unregisterDevice() {
    const deviceId = document.getElementById('deviceId').value;
    const userId = document.getElementById('userId').value;

    if (!deviceId || !userId) {
      this.showToast('warning', '⚠️ Please fill in Device ID and User ID');
      return;
    }

    try {
      const response = await fetch(`${this.baseURL}/api/test/unregister`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, userId })
      });

      const data = await response.json();

      if (data.success) {
        this.showToast('success', `✅ Device unregistered: ${deviceId}`);
        this.addMonitorMessage('info', 'Unregistration Published', 
          `Device: ${deviceId}\nTopic: ${data.topic}`);
        setTimeout(() => this.loadDevices(), 1000);
      } else {
        this.showToast('error', `❌ Unregistration failed: ${data.error}`);
      }
    } catch (error) {
      this.showToast('error', `❌ Error: ${error.message}`);
    }
  }

  async publishCustomMessage() {
    const deviceId = document.getElementById('custom-deviceId').value;
    const messageType = document.getElementById('messageType').value;
    const payloadText = document.getElementById('payload').value;
    const qos = parseInt(document.getElementById('qos').value);
    const retain = document.getElementById('retain').checked;

    try {
      const payload = JSON.parse(payloadText);

      const response = await fetch(`${this.baseURL}/api/test/publish-custom`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, messageType, payload, qos, retain })
      });

      const data = await response.json();

      if (data.success) {
        this.showToast('success', `✅ Message published to ${data.topic}`);
        this.addMonitorMessage('success', 'Custom Message Published', 
          `Topic: ${data.topic}\nQoS: ${qos}\nRetain: ${retain}`);
      } else {
        this.showToast('error', `❌ Publish failed: ${data.error}`);
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        this.showToast('error', '❌ Invalid JSON payload');
      } else {
        this.showToast('error', `❌ Error: ${error.message}`);
      }
    }
  }

  async loadDevices() {
    try {
      const response = await fetch(`${this.baseURL}/api/devices`);
      const devices = await response.json();

      this.updateDevicesList(devices);
      this.updateDeviceFilter(devices);
    } catch (error) {
      console.error('Failed to load devices:', error);
    }
  }

  async checkServerStatus() {
    try {
      const response = await fetch(`${this.baseURL}/health`);
      const health = await response.json();

      this.updateServerStatus(health);
    } catch (error) {
      this.updateServerStatus(null);
    }
  }

  // WebSocket Methods
  connectWebSocket() {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsURL = `${wsProtocol}//${window.location.host}/ws`;

    try {
      this.ws = new WebSocket(wsURL);

      this.ws.onopen = () => {
        console.log('WebSocket connected');
        this.updateConnectionStatus(true);
      };

      this.ws.onmessage = (event) => {
        this.handleWebSocketMessage(event.data);
      };

      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        this.updateConnectionStatus(false);
      };

      this.ws.onclose = () => {
        console.log('WebSocket disconnected');
        this.updateConnectionStatus(false);
        // Attempt to reconnect after 5 seconds
        setTimeout(() => this.connectWebSocket(), 5000);
      };
    } catch (error) {
      console.error('Failed to connect WebSocket:', error);
      this.updateConnectionStatus(false);
    }
  }

  handleWebSocketMessage(data) {
    if (this.monitorPaused) return;

    try {
      const message = JSON.parse(data);
      
      // Determine message type and display accordingly
      if (message.topic && message.topic.includes('/registration_ack')) {
        this.addMonitorMessage('success', 'Registration Confirmed', 
          `Device: ${message.deviceId || 'Unknown'}\nStatus: ${message.message || 'Confirmed'}\nNew Device: ${message.isNewDevice ? 'Yes' : 'No'}`);
      } else if (message.topic && message.topic.includes('/update')) {
        this.addMonitorMessage('info', 'Stats Update', 
          `Device: ${this.extractDeviceId(message.topic)}\nType: ${message.subtype || 'update'}`);
      } else if (message.topic && message.topic.includes('/milestone')) {
        this.addMonitorMessage('warning', 'Milestone Reached', 
          `Device: ${this.extractDeviceId(message.topic)}\nMilestone: ${message.payload?.milestone || 'Unknown'}`);
      } else {
        this.addMonitorMessage('info', 'MQTT Message', 
          `Topic: ${message.topic || 'Unknown'}\n${JSON.stringify(message, null, 2)}`);
      }
    } catch (error) {
      console.error('Error parsing WebSocket message:', error);
    }
  }

  // UI Update Methods
  updateDevicesList(devices) {
    const activeDevices = devices.filter(d => d.status === 'active');
    const inactiveDevices = devices.filter(d => d.status === 'inactive');

    document.getElementById('devices-count').textContent = 
      `${activeDevices.length} active, ${inactiveDevices.length} inactive`;

    const listHTML = devices.length === 0 ? 
      '<div class="loading">No devices registered</div>' :
      devices.map(device => {
        const lastSeen = this.formatTimeAgo(device.lastSeen);
        return `
          <div class="device-item">
            <span class="device-status ${device.status}"></span>
            <div class="device-info">
              <div class="device-id">${device.deviceId}</div>
              <div class="device-meta">
                ${device.status} • Last seen: ${lastSeen}
              </div>
            </div>
          </div>
        `;
      }).join('');

    document.getElementById('devices-list').innerHTML = listHTML;
  }

  updateDeviceFilter(devices) {
    const filter = document.getElementById('device-filter');
    const currentValue = filter.value;
    
    filter.innerHTML = '<option value="">All Devices</option>' +
      devices.map(d => `<option value="${d.deviceId}">${d.deviceId}</option>`).join('');
    
    if (currentValue) {
      filter.value = currentValue;
    }
  }

  updateServerStatus(health) {
    const connectionStatus = document.getElementById('connection-status');
    const mqttStatus = document.getElementById('mqtt-status');

    if (health) {
      connectionStatus.textContent = 'Connected';
      connectionStatus.className = 'status-badge status-connected';

      mqttStatus.textContent = `MQTT: ${health.mqtt.connected ? 'Connected' : 'Disconnected'}`;
      mqttStatus.className = health.mqtt.connected ? 
        'status-badge status-connected' : 'status-badge status-disconnected';
    } else {
      connectionStatus.textContent = 'Disconnected';
      connectionStatus.className = 'status-badge status-disconnected';
      
      mqttStatus.textContent = 'MQTT: Unknown';
      mqttStatus.className = 'status-badge status-unknown';
    }
  }

  updateConnectionStatus(connected) {
    // This could update a separate WebSocket status indicator if needed
  }

  updateTopicPreview() {
    const deviceId = document.getElementById('custom-deviceId').value || 'DEVICE_ID';
    const messageType = document.getElementById('messageType').value;
    
    const topicMap = {
      registration: 'active',
      status: 'status',
      update: 'update',
      milestone: 'milestone',
      alert: 'alert'
    };

    const topicSuffix = topicMap[messageType] || messageType;
    const topic = `statsnapp/${deviceId}/${topicSuffix}`;
    
    document.getElementById('topic-preview').textContent = `Topic: ${topic}`;
  }

  addMonitorMessage(type, title, content) {
    if (this.monitorPaused) return;

    const time = new Date().toLocaleTimeString();
    const message = { type, title, content, time, timestamp: Date.now() };
    
    this.messageHistory.unshift(message);
    if (this.messageHistory.length > this.maxMessages) {
      this.messageHistory.pop();
    }

    this.renderMonitor();
  }

  renderMonitor() {
    const filter = document.getElementById('device-filter').value;
    const messages = filter ? 
      this.messageHistory.filter(m => m.content.includes(filter)) :
      this.messageHistory;

    const monitorHTML = messages.length === 0 ?
      '<div class="monitor-message info"><div class="message-time">--:--:--</div><div class="message-content">No messages yet...</div></div>' :
      messages.map(m => `
        <div class="monitor-message ${m.type}">
          <div class="message-time">${m.time}</div>
          <div class="message-content"><strong>${m.title}</strong><br>${m.content.replace(/\n/g, '<br>')}</div>
        </div>
      `).join('');

    document.getElementById('message-monitor').innerHTML = monitorHTML;
  }

  clearMonitor() {
    this.messageHistory = [];
    this.renderMonitor();
    this.showToast('info', 'Monitor cleared');
  }

  toggleMonitor() {
    this.monitorPaused = !this.monitorPaused;
    const btn = document.getElementById('toggle-monitor-btn');
    btn.textContent = this.monitorPaused ? 'Resume' : 'Pause';
    this.showToast('info', this.monitorPaused ? 'Monitor paused' : 'Monitor resumed');
  }

  filterMessages() {
    this.renderMonitor();
  }

  // Utility Methods
  generateDeviceId() {
    const timestamp = Date.now();
    const deviceId = `STATSNAPP_US-${timestamp}`;
    document.getElementById('deviceId').value = deviceId;
    document.getElementById('custom-deviceId').value = deviceId;
    this.updateTopicPreview();
    this.showToast('success', `Generated device ID: ${deviceId}`);
  }

  extractDeviceId(topic) {
    const match = topic.match(/statsnapp\/([^\/]+)\//);
    return match ? match[1] : 'Unknown';
  }

  formatTimeAgo(timestamp) {
    const now = Date.now();
    const time = new Date(timestamp).getTime();
    const diff = now - time;

    if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
  }

  showToast(type, message) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    const icons = {
      success: '✅',
      error: '❌',
      info: 'ℹ️',
      warning: '⚠️'
    };

    toast.innerHTML = `
      <span class="toast-icon">${icons[type] || 'ℹ️'}</span>
      <span class="toast-message">${message}</span>
    `;

    container.appendChild(toast);

    setTimeout(() => {
      toast.style.animation = 'slideOut 0.3s ease-out';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }
}

// Initialize the app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  window.mqttTester = new MQTTTester();
});

