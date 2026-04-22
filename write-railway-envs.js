const fs = require('fs');

try {
  const rootCA = fs.readFileSync('src/certs/root-ca.crt', 'utf8');
  // Local broker configuration was removed from this repo; this script now only exports the CA.

  let output = '=== PASTE THESE INTO YOUR RAILWAY DASHBOARD FOR NANOMQ ===\n\n';
  output += 'NANOMQ_TLS_CA_CERT=\n' + rootCA.replace(/\r/g, '').replace(/\n/g, '\\n') + '\n\n';

  fs.writeFileSync('railway-env-vars.txt', output);
  console.log("Successfully wrote railway-env-vars.txt - Please open this file and copy the values!");
} catch (err) {
  console.error("Error reading certificate files:", err.message);
}
