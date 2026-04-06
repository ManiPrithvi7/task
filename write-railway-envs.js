const fs = require('fs');

try {
  const rootCA = fs.readFileSync('data/ca/root-ca.crt', 'utf8');
  const brokerCrt = fs.readFileSync('broker/certs/broker.crt', 'utf8');
  const brokerKey = fs.readFileSync('broker/certs/broker.key', 'utf8');

  let output = '=== PASTE THESE INTO YOUR RAILWAY DASHBOARD FOR NANOMQ ===\n\n';
  output += 'NANOMQ_TLS_CA_CERT=\n' + rootCA.replace(/\r/g, '').replace(/\n/g, '\\n') + '\n\n';
  output += 'NANOMQ_TLS_CERT=\n' + brokerCrt.replace(/\r/g, '').replace(/\n/g, '\\n') + '\n\n';
  output += 'NANOMQ_TLS_KEY=\n' + brokerKey.replace(/\r/g, '').replace(/\n/g, '\\n') + '\n\n';

  fs.writeFileSync('railway-env-vars.txt', output);
  console.log("Successfully wrote railway-env-vars.txt - Please open this file and copy the values!");
} catch (err) {
  console.error("Error reading certificate files:", err.message);
}
