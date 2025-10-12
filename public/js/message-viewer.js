// Enhanced MQTT Message Viewer Component

class MqttMessageViewer {
  constructor(containerId, statsId) {
    this.container = document.getElementById(containerId);
    this.statsContainer = document.getElementById(statsId);
    this.messages = [];
    this.filters = {
      topic: '',
      direction: 'all',
      deviceId: '',
      minQos: 0,
      source: 'all'
    };
    this.isPaused = false;
    this.maxMessages = 500;
    this.stats = {
      total: 0,
      clientToServer: 0,
      serverToClient: 0,
      brokerToServer: 0,
      lastMinute: []
    };
  }

  addMessage(message) {
    if (this.isPaused) return;
    if (!this.matchesFilter(message)) return;
    
    // Add unique ID
    const enhancedMessage = {
      ...message,
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      receivedAt: new Date()
    };
    
    this.messages.unshift(enhancedMessage);
    
    // Trim old messages
    if (this.messages.length > this.maxMessages) {
      this.messages = this.messages.slice(0, this.maxMessages);
    }
    
    // Update statistics
    this.updateStats(message);
    
    // Render
    this.render();
  }

  matchesFilter(message) {
    // Topic filter (supports MQTT wildcards)
    if (this.filters.topic) {
      const regex = this.topicToRegex(this.filters.topic);
      if (!regex.test(message.topic || '')) return false;
    }
    
    // Direction filter
    if (this.filters.direction !== 'all' && message.direction !== this.filters.direction) {
      return false;
    }
    
    // Device ID filter
    if (this.filters.deviceId && !message.deviceId?.includes(this.filters.deviceId)) {
      return false;
    }
    
    // QoS filter
    if (message.qos !== undefined && message.qos < this.filters.minQos) {
      return false;
    }

    // Source filter
    if (this.filters.source !== 'all' && message.source !== this.filters.source) {
      return false;
    }
    
    return true;
  }

  topicToRegex(pattern) {
    // Convert MQTT wildcards to regex
    const regexPattern = pattern
      .replace(/\+/g, '[^/]+')
      .replace(/#/g, '.*')
      .replace(/\//g, '\\/');
    return new RegExp(`^${regexPattern}$`);
  }

  updateStats(message) {
    this.stats.total++;
    
    // Count by direction
    if (message.direction === 'client_to_server') {
      this.stats.clientToServer++;
    } else if (message.direction === 'server_to_client') {
      this.stats.serverToClient++;
    } else if (message.direction === 'broker_to_server') {
      this.stats.brokerToServer++;
    }
    
    // Track messages in last minute for rate calculation
    const now = Date.now();
    this.stats.lastMinute.push(now);
    this.stats.lastMinute = this.stats.lastMinute.filter(t => now - t < 60000);
    
    this.renderStats();
  }

  renderStats() {
    if (!this.statsContainer) return;
    
    const rate = this.stats.lastMinute.length > 0 
      ? (this.stats.lastMinute.length / 60).toFixed(1) 
      : '0.0';
    
    this.statsContainer.innerHTML = `
      <span>📊 Total: <strong>${this.stats.total}</strong></span>
      <span>⬆️ Client→Server: <strong>${this.stats.clientToServer}</strong></span>
      <span>⬇️ Server→Client: <strong>${this.stats.serverToClient}</strong></span>
      <span>📨 Broker→Server: <strong>${this.stats.brokerToServer}</strong></span>
      <span>📈 Rate: <strong>${rate}</strong> msg/s</span>
    `;
  }

  render() {
    if (!this.container) return;
    
    const visibleMessages = this.messages.filter(msg => this.matchesFilter(msg));
    
    if (visibleMessages.length === 0) {
      this.container.innerHTML = '<div class="empty-state">No messages match the current filters</div>';
      return;
    }
    
    const html = visibleMessages.map(msg => this.renderMessage(msg)).join('');
    this.container.innerHTML = html;
  }

  renderMessage(msg) {
    const directionIcon = this.getDirectionIcon(msg.direction);
    const directionClass = msg.direction?.replace(/_/g, '-') || 'unknown';
    const sourceIcon = this.getSourceIcon(msg.source);
    
    // Format payload with syntax highlighting
    const formattedPayload = this.formatPayload(msg.payload);
    
    return `
      <div class="message-item ${directionClass}" data-id="${msg.id}">
        <div class="message-header">
          <span class="direction-badge ${directionClass}">
            ${directionIcon} ${this.formatDirection(msg.direction)}
          </span>
          <span class="source-badge">
            ${sourceIcon} ${this.formatSource(msg.source)}
          </span>
          <span class="message-time" title="${msg.timestamp}">${this.formatTime(msg.timestamp)}</span>
          <button class="btn-icon" onclick="window.messageViewer.copyMessage('${msg.id}')" title="Copy message">📋</button>
          <button class="btn-icon" onclick="window.messageViewer.viewRawMessage('${msg.id}')" title="View raw JSON">🔍</button>
        </div>
        <div class="message-topic-row">
          <span class="message-topic-label">Topic:</span>
          <code class="message-topic">${this.escapeHtml(msg.topic || 'unknown')}</code>
          ${msg.deviceId ? `<span class="device-badge">${this.escapeHtml(msg.deviceId)}</span>` : ''}
          ${msg.qos !== undefined ? `<span class="qos-badge">QoS ${msg.qos}</span>` : ''}
          ${msg.retain ? '<span class="retain-badge">Retained</span>' : ''}
        </div>
        <div class="message-payload">
          <pre><code>${formattedPayload}</code></pre>
        </div>
        <div class="message-meta">
          ${msg.byteSize ? `${msg.byteSize} bytes` : ''}
          ${msg.deliveryTime ? ` • ${msg.deliveryTime}ms` : ''}
          ${msg.packetId ? ` • Packet: ${msg.packetId}` : ''}
        </div>
      </div>
    `;
  }

  getDirectionIcon(direction) {
    const icons = {
      'client_to_server': '⬆️',
      'server_to_client': '⬇️',
      'broker_to_server': '📨',
      'server_to_broker': '📤'
    };
    return icons[direction] || '↔️';
  }

  getSourceIcon(source) {
    const icons = {
      'http_api': '🌐',
      'websocket': '🔌',
      'backend': '⚙️',
      'broker': '📡',
      'device': '📱',
      'system': '🖥️'
    };
    return icons[source] || '❓';
  }

  formatDirection(direction) {
    if (!direction) return 'UNKNOWN';
    return direction.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' → ');
  }

  formatSource(source) {
    if (!source) return 'unknown';
    return source.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }

  formatTime(timestamp) {
    if (!timestamp) return '--:--:--';
    const date = new Date(timestamp);
    return date.toLocaleTimeString();
  }

  formatPayload(payload) {
    if (!payload) return '';
    
    try {
      const parsed = JSON.parse(payload);
      return this.syntaxHighlight(JSON.stringify(parsed, null, 2));
    } catch {
      return this.escapeHtml(payload);
    }
  }

  syntaxHighlight(json) {
    json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, function (match) {
      let cls = 'json-number';
      if (/^"/.test(match)) {
        if (/:$/.test(match)) {
          cls = 'json-key';
        } else {
          cls = 'json-string';
        }
      } else if (/true|false/.test(match)) {
        cls = 'json-boolean';
      } else if (/null/.test(match)) {
        cls = 'json-null';
      }
      return '<span class="' + cls + '">' + match + '</span>';
    });
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  setFilter(key, value) {
    this.filters[key] = value;
    this.render();
  }

  clearFilters() {
    this.filters = {
      topic: '',
      direction: 'all',
      deviceId: '',
      minQos: 0,
      source: 'all'
    };
    this.render();
  }

  togglePause() {
    this.isPaused = !this.isPaused;
    return this.isPaused;
  }

  clear() {
    this.messages = [];
    this.stats = {
      total: 0,
      clientToServer: 0,
      serverToClient: 0,
      brokerToServer: 0,
      lastMinute: []
    };
    this.render();
    this.renderStats();
  }

  copyMessage(id) {
    const message = this.messages.find(m => m.id === id);
    if (!message) return;
    
    const text = JSON.stringify({
      topic: message.topic,
      payload: message.payload,
      qos: message.qos,
      retain: message.retain,
      direction: message.direction,
      source: message.source,
      timestamp: message.timestamp
    }, null, 2);
    
    navigator.clipboard.writeText(text).then(() => {
      this.showToast('✅ Message copied to clipboard', 'success');
    }).catch(() => {
      this.showToast('❌ Failed to copy message', 'error');
    });
  }

  viewRawMessage(id) {
    const message = this.messages.find(m => m.id === id);
    if (!message) return;
    
    const raw = JSON.stringify(message, null, 2);
    
    // Create modal
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h3>Raw Message Data</h3>
          <button class="btn-close" onclick="this.closest('.modal-overlay').remove()">✕</button>
        </div>
        <div class="modal-body">
          <pre><code>${this.syntaxHighlight(raw)}</code></pre>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Close</button>
        </div>
      </div>
    `;
    
    document.body.appendChild(modal);
    modal.onclick = (e) => {
      if (e.target === modal) modal.remove();
    };
  }

  exportMessages(format = 'json') {
    const data = format === 'json' 
      ? JSON.stringify(this.messages, null, 2)
      : this.convertToCSV(this.messages);
    
    const mimeType = format === 'json' ? 'application/json' : 'text/csv';
    const blob = new Blob([data], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mqtt-messages-${Date.now()}.${format}`;
    a.click();
    URL.revokeObjectURL(url);
    
    this.showToast(`✅ Exported ${this.messages.length} messages as ${format.toUpperCase()}`, 'success');
  }

  convertToCSV(messages) {
    if (messages.length === 0) return '';
    
    const headers = ['Timestamp', 'Topic', 'Direction', 'Source', 'QoS', 'Retain', 'Device ID', 'Payload', 'Byte Size'];
    const rows = messages.map(msg => [
      msg.timestamp,
      msg.topic,
      msg.direction,
      msg.source,
      msg.qos,
      msg.retain,
      msg.deviceId || '',
      JSON.stringify(msg.payload).replace(/"/g, '""'),
      msg.byteSize
    ]);
    
    const csv = [headers, ...rows].map(row => row.map(cell => `"${cell}"`).join(',')).join('\n');
    return csv;
  }

  showToast(message, type = 'info') {
    // Use the global toast function if available
    if (window.showToast) {
      window.showToast(type, message);
    } else {
      console.log(`[${type}] ${message}`);
    }
  }
}

// Message Templates
const MESSAGE_TEMPLATES = {
  device_registration: {
    name: 'Device Registration',
    topic: 'statsnapp/${deviceId}/active',
    payload: {
      type: 'device_registration',
      userId: '${userId}',
      clientId: '${deviceId}',
      deviceType: 'mobile',
      os: 'iOS 17.0',
      appVersion: '1.0.0',
      timestamp: '${timestamp}'
    }
  },
  device_unregistration: {
    name: 'Device Unregistration',
    topic: 'statsnapp/${deviceId}/active',
    payload: {
      type: 'un_registration',
      userId: '${userId}',
      clientId: '${deviceId}',
      timestamp: '${timestamp}'
    }
  },
  status_update: {
    name: 'Status Update',
    topic: 'statsnapp/${deviceId}/status',
    payload: {
      type: 'status',
      status: 'online',
      uptime: 3600,
      timestamp: '${timestamp}'
    }
  },
  metrics_update: {
    name: 'Metrics Update',
    topic: 'statsnapp/${deviceId}/update',
    payload: {
      type: 'live_update',
      subtype: 'follower_count',
      stats: {
        followers: 1250,
        following: 456,
        posts: 89
      },
      timestamp: '${timestamp}'
    }
  },
  milestone: {
    name: 'Milestone Alert',
    topic: 'statsnapp/${deviceId}/milestone',
    payload: {
      type: 'milestone',
      milestone: '1000_followers',
      current_value: 1000,
      message: 'Congratulations! You reached 1000 followers!',
      timestamp: '${timestamp}'
    }
  },
  alert: {
    name: 'Alert Message',
    topic: 'statsnapp/${deviceId}/alert',
    payload: {
      type: 'alert',
      alert_type: 'warning',
      message: 'Unusual activity detected',
      severity: 'medium',
      timestamp: '${timestamp}'
    }
  }
};

// Template helper functions
function loadTemplate(templateName, deviceId = '', userId = '') {
  const template = MESSAGE_TEMPLATES[templateName];
  if (!template) return null;
  
  const now = new Date().toISOString();
  const topic = template.topic
    .replace('${deviceId}', deviceId || 'DEVICE_ID')
    .replace('${userId}', userId || 'USER_ID');
  
  const payloadStr = JSON.stringify(template.payload, null, 2)
    .replace(/"\${deviceId}"/g, `"${deviceId || 'DEVICE_ID'}"`)
    .replace(/"\${userId}"/g, `"${userId || 'USER_ID'}"`)
    .replace(/"\${timestamp}"/g, `"${now}"`);
  
  return {
    topic,
    payload: payloadStr
  };
}

function applyTemplate(templateName) {
  const deviceId = document.getElementById('custom-deviceId')?.value || '';
  const userId = document.getElementById('userId')?.value || '';
  
  const template = loadTemplate(templateName, deviceId, userId);
  if (!template) return;
  
  if (document.getElementById('custom-deviceId')) {
    document.getElementById('custom-deviceId').value = deviceId || template.topic.split('/')[1];
  }
  
  if (document.getElementById('payload')) {
    document.getElementById('payload').value = template.payload;
  }
  
  // Update topic preview
  if (window.mqttTester && window.mqttTester.updateTopicPreview) {
    window.mqttTester.updateTopicPreview();
  }
  
  // Show success
  if (window.showToast) {
    window.showToast('success', `✅ Template "${MESSAGE_TEMPLATES[templateName].name}" loaded`);
  }
}

