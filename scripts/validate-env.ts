#!/usr/bin/env bun
/**
 * CI helper: load and validate environment using the same rules as runtime `validateConfig`.
 *
 * Usage:
 *   bun scripts/validate-env.ts
 *   bun scripts/validate-env.ts --production
 */
import { loadConfig, validateConfig } from '../src/config';

const productionMode = process.argv.includes('--production');
if (productionMode) {
  process.env.NODE_ENV = 'production';
}

try {
  const config = loadConfig();
  validateConfig(config);
  console.log(`Environment validation passed (${config.app.env})`);
} catch (err: unknown) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
