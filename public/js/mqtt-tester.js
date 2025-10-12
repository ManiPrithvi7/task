// MQTT Publisher Lite - Testing Interface Client

class MQTTTester {
  constructor() {
    this.baseURL = window.location.origin;
    this.ws = null;
    
    this.init();
  }

  init() {
    // Initialize message viewer (from message-viewer.js)
    window.messageViewer = new MqttMessageViewer('message-viewer', 'message-stats');
    
    // Initialize UI
    this.setupEventListeners();
    this.setupFilterListeners();
    this.loadDevices();
    this.checkServerStatus();
    this.connectWebSocket();
    
    // Auto-refresh devices every 10 seconds
    setInterval(() => this.loadDevices(), 10000);
    
    // Auto-refresh server status every 5 seconds
    setInterval(() => this.checkServerStatus(), 5000);
    
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

    // Clear viewer button
    document.getElementById('clear-viewer-btn').addEventListener('click', () => {
      window.messageViewer.clear();
      this.showToast('info', 'Message viewer cleared');
    });

    // Toggle pause button
    document.getElementById('pause-viewer-btn').addEventListener('click', (e) => {
      const isPaused = window.messageViewer.togglePause();
      e.target.textContent = isPaused ? '▶️ Resume' : '⏸️ Pause';
      this.showToast('info', isPaused ? 'Viewer paused' : 'Viewer resumed');
    });

    // Export buttons
    document.getElementById('export-json-btn').addEventListener('click', () => {
      window.messageViewer.exportMessages('json');
    });

    document.getElementById('export-csv-btn').addEventListener('click', () => {
      window.messageViewer.exportMessages('csv');
    });
  }

  setupFilterListeners() {
    // Topic filter
    const topicFilter = document.getElementById('topic-filter');
    if (topicFilter) {
      topicFilter.addEventListener('input', (e) => {
        window.messageViewer.setFilter('topic', e.target.value);
      });
    }

    // Direction filter
    const directionFilter = document.getElementById('direction-filter');
    if (directionFilter) {
      directionFilter.addEventListener('change', (e) => {
        window.messageViewer.setFilter('direction', e.target.value);
      });
    }

    // QoS filter
    const qosFilter = document.getElementById('qos-filter');
    if (qosFilter) {
      qosFilter.addEventListener('change', (e) => {
        window.messageViewer.setFilter('minQos', parseInt(e.target.value));
      });
    }

    // Source filter
    const sourceFilter = document.getElementById('source-filter');
    if (sourceFilter) {
      sourceFilter.addEventListener('change', (e) => {
        window.messageViewer.setFilter('source', e.target.value);
      });
    }

    // Device ID filter
    const deviceIdFilter = document.getElementById('device-filter');
    if (deviceIdFilter) {
      deviceIdFilter.addEventListener('input', (e) => {
        window.messageViewer.setFilter('deviceId', e.target.value);
      });
    }

    // Clear filters button
    const clearFiltersBtn = document.getElementById('clear-filters-btn');
    if (clearFiltersBtn) {
      clearFiltersBtn.addEventListener('click', () => {
        window.messageViewer.clearFilters();
        // Reset filter inputs
        if (topicFilter) topicFilter.value = '';
        if (directionFilter) directionFilter.value = 'all';
        if (qosFilter) qosFilter.value = '0';
        if (sourceFilter) sourceFilter.value = 'all';
        if (deviceIdFilter) deviceIdFilter.value = '';
        this.showToast('info', 'Filters cleared');
      });
    }
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
    try {
      const message = JSON.parse(data);
      
      // Skip non-message events
      if (message.type !== 'message') {
        return;
      }
      
      // Add message to viewer
      window.messageViewer.addMessage(message);
      
      // Reload devices if it's a registration/unregistration
      if (message.topic && (message.topic.includes('/active') || message.topic.includes('/registration'))) {
        setTimeout(() => this.loadDevices(), 500);
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
    // No longer needed - device filter is now a text input in message viewer
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

// Global toast function for other components
window.showToast = function(type, message) {
  if (window.mqttTester) {
    window.mqttTester.showToast(type, message);
  }
};

// Initialize the app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  window.mqttTester = new MQTTTester();
});

