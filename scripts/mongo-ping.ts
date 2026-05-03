/**
 * Validate .env Mongo settings and ping Atlas/cluster over the Mongo wire protocol.
 *
 * Note: MongoDB is not HTTP — `curl` cannot authenticate or ping the database.
 * Use: npm run mongo:ping
 */

import dns from 'dns/promises';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { mongoDriverTimeouts } from '../src/config/mongoConnection';

dotenv.config();

function sanitizeUri(uri: string): string {
  try {
    return uri.replace(/:[^:@]+@/, ':****@');
  } catch {
    return '[invalid]';
  }
}

function validateUriShape(uri: string): string | null {
  if (!/^mongodb(\+srv)?:\/\//i.test(uri)) {
    return 'MONGODB_URI must start with mongodb:// or mongodb+srv://';
  }
  return null;
}

/** Host part after mongodb+srv:// [userinfo@] host — excludes db path & query string. */
function mongodbSrvHostname(uri: string): string | null {
  if (!/^mongodb\+srv:\/\//i.test(uri)) return null;
  let rest = uri.replace(/^mongodb\+srv:\/\//i, '');
  const at = rest.lastIndexOf('@');
  if (at !== -1) rest = rest.slice(at + 1);
  rest = rest.split('/')[0].split('?')[0];
  const host = rest.trim();
  return host || null;
}

async function main(): Promise<void> {
  const uri = (process.env.MONGODB_URI || process.env.MONGO_URI || '').trim();
  const dbName = (process.env.MONGODB_DB_NAME || 'statsmqtt').trim();

  console.log('mongo-ping: loading .env and validating Mongo env…');

  if (!uri) {
    console.error('FAIL: MONGODB_URI (or MONGO_URI) is missing.');
    process.exit(1);
  }

  const shapeErr = validateUriShape(uri);
  if (shapeErr) {
    console.error(`FAIL: ${shapeErr}`);
    process.exit(1);
  }

  const timeouts = mongoDriverTimeouts();
  console.log(`URI (sanitized): ${sanitizeUri(uri)}`);
  console.log(`DB name: ${dbName}`);
  console.log(
    `Timeouts: serverSelection=${timeouts.serverSelectionTimeoutMS}ms connect=${timeouts.connectTimeoutMS}ms`
  );

  const hostname = mongodbSrvHostname(uri);
  if (hostname) {
    try {
      const records = await dns.resolveSrv(`_mongodb._tcp.${hostname}`);
      console.log(`DNS SRV OK: ${records.length} target(s) under _mongodb._tcp.${hostname}`);
    } catch (dnsErr) {
      console.warn(
        'DNS SRV warning:',
        dnsErr instanceof Error ? dnsErr.message : String(dnsErr)
      );
    }
  }

  try {
    await mongoose.connect(uri, {
      dbName,
      maxPoolSize: 5,
      ...timeouts,
      socketTimeoutMS: 45_000,
      bufferCommands: false
    });

    const db = mongoose.connection.db;
    if (!db) {
      console.error('FAIL: No database handle after connect.');
      process.exit(1);
    }

    const ping = await db.admin().ping();
    console.log('OK: MongoDB ping response:', ping);

    await mongoose.disconnect();
    console.log('OK: disconnected.');
    process.exit(0);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('FAIL:', msg);
    console.error(
      'Tip: Atlas → Network Access → allow your current IP (or VPN off). Raise timeouts via MONGODB_SERVER_SELECTION_TIMEOUT_MS if needed.'
    );
    try {
      await mongoose.disconnect();
    } catch {
      /* ignore */
    }
    process.exit(1);
  }
}

void main();
