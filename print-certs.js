const fs = require('fs');

try {
  const rootCA = fs.readFileSync('data/ca/root-ca.crt', 'utf8');
  const brokerCrt = fs.readFileSync('broker/certs/broker.crt', 'utf8');
  const brokerKey = fs.readFileSync('broker/certs/broker.key', 'utf8');

  // console.log('For NanoMQ (with \\n added):');
  // console.log('=============================');
  console.log('NANOMQ_TLS_CA_CERT="' + rootCA.replace(/\r/g, '').replace(/\n/g, '\\n') + '"\n');
  // console.log('NANOMQ_TLS_CERT="' + brokerCrt.replace(/\r/g, '').replace(/\n/g, '\\n') + '"\n');
  // console.log('NANOMQ_TLS_KEY="' + brokerKey.replace(/\r/g, '').replace(/\n/g, '\\n') + '"\n');

  console.log('\nFor Server Base64 version:');
  console.log('=============================');
  //   console.log('MQTT_TLS_CA_BASE64=' + Buffer.from(rootCA).toString('base64') + '\n');
  //   console.log('MQTT_TLS_CLIENT_CERT_BASE64=' + Buffer.from(brokerCrt).toString('base64') + '\n');
  //   console.log('MQTT_TLS_CLIENT_KEY_BASE64=' + Buffer.from(brokerKey).toString('base64') + '\n');
} catch (err) {
  console.error("Error reading certificate files:", err.message);
}





