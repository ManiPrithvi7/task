/**
 * Minimal mTLS connectivity probe (same TLS options as MqttClientManager).
 * Usage: npm run test:mqtt-mtls
 */
import dotenv from 'dotenv';
import * as tls from 'tls';
import { loadConfig } from '../src/config';
import { buildNodeTlsConnectOptions, resolveMqttTcpHost } from '../src/utils/mqttTlsOptions';

dotenv.config();

async function main(): Promise<void> {
  const config = loadConfig();
  const tlsCfg = config.mqtt.tls;
  if (!tlsCfg?.enabled || !tlsCfg.caPem) {
    throw new Error('MQTT TLS not configured (need MQTT_TLS_CA_BASE64 + client cert/key)');
  }

  const broker = config.mqtt.broker;
  const port = config.mqtt.port;
  const servername = tlsCfg.servername || broker;
  const { connectHost, brokerHost } = await resolveMqttTcpHost(broker, servername);

  console.log('[test-mqtt-mtls]', { brokerHost, connectHost, port, servername });

  await new Promise<void>((resolve, reject) => {
    const socket = tls.connect(
      buildNodeTlsConnectOptions(
        {
          caPem: tlsCfg.caPem!,
          clientCertPem: tlsCfg.clientCertPem,
          clientKeyPem: tlsCfg.clientKeyPem,
          rejectUnauthorized: tlsCfg.rejectUnauthorized !== false,
          servername
        },
        connectHost,
        port
      ),
      () => {
        console.log('[test-mqtt-mtls] TLS OK', socket.getProtocol(), socket.getCipher()?.name);
        socket.end();
        resolve();
      }
    );
    socket.on('error', reject);
    setTimeout(() => reject(new Error('timeout')), 15000);
  });
}

main().catch((err) => {
  console.error('[test-mqtt-mtls] FAIL:', err instanceof Error ? err.message : err);
  process.exit(1);
});
