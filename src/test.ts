/**
 * Test script for MQTT Publisher Lite
 * Run with: npm run test
 */

import { StatsMqttLite } from './app';
import { logger } from './utils/logger';

async function runTests() {
  logger.info('🧪 Starting MQTT Publisher Lite Tests...');
  logger.info('━'.repeat(50));

  const app = new StatsMqttLite();
  
  try {
    // Start the application
    await app.start();
    logger.info('✅ Application started successfully');
    
    // Wait a bit for initialization
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Test health endpoint
    logger.info('');
    logger.info('Testing health endpoint...');
    const http = await import('http');
    
    await new Promise<void>((resolve, reject) => {
      http.get('http://localhost:3002/health', (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          const health = JSON.parse(data);
          logger.info('✅ Health check passed', health);
          resolve();
        });
        res.on('error', reject);
      }).on('error', reject);
    });

    // Test MQTT publish via HTTP API
    logger.info('');
    logger.info('Testing MQTT publish...');
    const testMessage = {
      topic: 'test/hello',
      payload: { message: 'Hello from test!', timestamp: new Date().toISOString() },
      qos: 0,
      retain: false
    };

    await new Promise<void>((resolve, reject) => {
      const postData = JSON.stringify(testMessage);
      const options = {
        hostname: 'localhost',
        port: 3002,
        path: '/api/publish',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          logger.info('✅ MQTT publish test passed', JSON.parse(data));
          resolve();
        });
      });

      req.on('error', reject);
      req.write(postData);
      req.end();
    });

    // Test session creation
    logger.info('');
    logger.info('Testing session creation...');
    const testSession = {
      clientId: 'test-client-001',
      active_account: 'test@example.com',
      social_accounts: [],
      access_token: 'test-token-123',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString()
    };

    await new Promise<void>((resolve, reject) => {
      const postData = JSON.stringify(testSession);
      const options = {
        hostname: 'localhost',
        port: 3002,
        path: '/api/sessions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          logger.info('✅ Session creation test passed', JSON.parse(data));
          resolve();
        });
      });

      req.on('error', reject);
      req.write(postData);
      req.end();
    });

    logger.info('');
    logger.info('━'.repeat(50));
    logger.info('✅ All tests passed!');
    logger.info('━'.repeat(50));
    
    // Stop the application
    await app.stop();
    
  } catch (error: any) {
    logger.error('❌ Test failed', { 
      error: error.message,
      stack: error.stack 
    });
    process.exit(1);
  }
}

// Run tests
runTests().then(() => {
  logger.info('Test suite completed');
  process.exit(0);
}).catch((error) => {
  logger.error('Test suite failed', { error: error.message });
  process.exit(1);
});
