const fs = require('fs');

try {
  const rootCA = fs.readFileSync('src/certs/root-ca.crt', 'utf8');
  const brokerCrt = fs.readFileSync('broker/certs/broker.crt', 'utf8');
  const brokerKey = fs.readFileSync('broker/certs/broker.key', 'utf8');

  let output = '=== PASTE THESE MULTI-LINE TEXTS EXACTLY AS-IS INTO RAILWAY ===\n\n';
  output += 'NANOMQ_TLS_CA_CERT:\n' + rootCA + '\n\n';
  output += 'NANOMQ_TLS_CERT:\n' + brokerCrt + '\n\n';
  output += 'NANOMQ_TLS_KEY:\n' + brokerKey + '\n\n';

  fs.writeFileSync('railway-env-vars-raw.txt', output);
  console.log("Successfully wrote railway-env-vars-raw.txt with normal, unescaped newlines!");
} catch (err) {
  console.error("Error reading certificate files:", err.message);
}
