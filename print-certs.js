const fs = require('fs');

try {
  const rootCA = fs.readFileSync('src/certs/root-ca.crt', 'utf8');
  // Local broker configuration was removed from this repo. This script only prints the CA payload.

  // console.log('For NanoMQ (with \\n added):');
  // console.log('=============================');
  console.log('NANOMQ_TLS_CA_CERT="' + rootCA.replace(/\r/g, '').replace(/\n/g, '\\n') + '"\n');

  console.log('\nFor Server Base64 version:');
  console.log('=============================');
  //   console.log('MQTT_TLS_CA_BASE64=' + Buffer.from(rootCA).toString('base64') + '\n');
} catch (err) {
  console.error("Error reading certificate files:", err.message);
}





