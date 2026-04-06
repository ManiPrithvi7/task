import { CAService } from './src/services/caService';
import * as path from 'path';

async function main() {
  console.log('Initializing CAService to generate PROOF-CA Root CA...');
  const config = {
    storagePath: path.resolve(__dirname, 'data/ca'),
    rootCAValidityYears: 10,
    deviceCertValidityDays: 3650
  };

  const caService = new CAService(config);
  await caService.initialize();
  console.log('Root CA successfully initialized.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
