/**
 * Connection Test Script
 * Tests MongoDB and Redis cloud connections
 */

import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { createClient } from 'redis';

// Load environment variables
dotenv.config();

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[36m',
  bold: '\x1b[1m'
};

async function testMongoDB() {
  console.log(`\n${colors.blue}${colors.bold}🗃️  Testing MongoDB Connection...${colors.reset}`);
  console.log('━'.repeat(60));
  
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  const dbName = process.env.MONGODB_DB_NAME || 'statsmqtt';
  
  if (!mongoUri) {
    console.log(`${colors.red}❌ MongoDB URI not set${colors.reset}`);
    console.log(`${colors.yellow}   Set MONGODB_URI environment variable${colors.reset}`);
    return false;
  }
  
  console.log(`📍 URI: ${sanitizeUri(mongoUri)}`);
  console.log(`📦 Database: ${dbName}`);
  
  try {
    const startTime = Date.now();
    
    await mongoose.connect(mongoUri, {
      dbName,
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000
    });
    
    const connectionTime = Date.now() - startTime;
    
    // Test operations
    const db = mongoose.connection.db;
    if (db) {
      await db.admin().ping();
      const collections = await db.listCollections().toArray();
      
      console.log(`${colors.green}✅ MongoDB Connected Successfully!${colors.reset}`);
      console.log(`⏱️  Connection Time: ${connectionTime}ms`);
      console.log(`📊 Collections Found: ${collections.length}`);
      
      if (collections.length > 0) {
        console.log(`📋 Collection Names:`);
        collections.forEach(col => {
          console.log(`   - ${col.name}`);
        });
      }
    }
    
    await mongoose.disconnect();
    console.log(`${colors.green}✅ MongoDB Disconnected Gracefully${colors.reset}`);
    return true;
    
  } catch (error: any) {
    console.log(`${colors.red}❌ MongoDB Connection Failed${colors.reset}`);
    console.log(`${colors.red}   Error: ${error.message}${colors.reset}`);
    return false;
  }
}

async function testRedis() {
  console.log(`\n${colors.blue}${colors.bold}💾 Testing Redis Connection...${colors.reset}`);
  console.log('━'.repeat(60));
  
  const redisHost = process.env.REDIS_HOST;
  const redisPort = process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT, 10) : undefined;
  const redisPassword = process.env.REDIS_PASSWORD;
  const redisTls = process.env.REDIS_TLS === 'true' || process.env.REDIS_TLS === '1';

  if (!redisHost || redisPort === undefined) {
    console.log(`${colors.yellow}⚠️  Redis not configured${colors.reset}`);
    console.log(`${colors.yellow}   Set REDIS_HOST and REDIS_PORT (and REDIS_PASSWORD if required)${colors.reset}`);
    return false;
  }

  let client;
  try {
    const startTime = Date.now();
    console.log(`📍 Host: ${redisHost}`);
    console.log(`🔢 Port: ${redisPort}`);

    client = createClient({
      username: 'default',
      password: redisPassword,
      socket: {
        host: redisHost,
        port: redisPort,
        connectTimeout: 10000,
        tls: redisTls ? undefined : false
      }
    });
    
    // Setup error handler
    client.on('error', (err) => {
      console.log(`${colors.red}Redis Error: ${err.message}${colors.reset}`);
    });
    
    await client.connect();
    const connectionTime = Date.now() - startTime;
    
    // Test operations
    const pong = await client.ping();
    const testKey = 'test:connection:' + Date.now();
    await client.set(testKey, 'Hello from connection test!', { EX: 10 });
    const testValue = await client.get(testKey);
    await client.del(testKey);
    
    // Get info
    const info = await client.info('server');
    const versionMatch = info.match(/redis_version:([^\r\n]+)/);
    const version = versionMatch ? versionMatch[1] : 'Unknown';
    
    console.log(`${colors.green}✅ Redis Connected Successfully!${colors.reset}`);
    console.log(`⏱️  Connection Time: ${connectionTime}ms`);
    console.log(`🏓 Ping Response: ${pong}`);
    console.log(`📝 Write/Read Test: ${testValue === 'Hello from connection test!' ? 'PASS' : 'FAIL'}`);
    console.log(`🔢 Redis Version: ${version}`);
    
    await client.quit();
    console.log(`${colors.green}✅ Redis Disconnected Gracefully${colors.reset}`);
    return true;
    
  } catch (error: any) {
    console.log(`${colors.red}❌ Redis Connection Failed${colors.reset}`);
    console.log(`${colors.red}   Error: ${error.message}${colors.reset}`);
    
    if (client) {
      try {
        await client.quit();
      } catch {}
    }
    return false;
  }
}

function sanitizeUri(uri: string): string {
  try {
    const url = new URL(uri);
    if (url.password) {
      return uri.replace(`:${url.password}@`, ':***@');
    }
    return uri;
  } catch {
    return '[invalid URI]';
  }
}

async function main() {
  console.log(`${colors.bold}\n${'═'.repeat(60)}`);
  console.log(`   🧪 Cloud Connection Test - mqtt-publisher-lite`);
  console.log(`${'═'.repeat(60)}${colors.reset}\n`);
  
  const mongoSuccess = await testMongoDB();
  const redisSuccess = await testRedis();
  
  console.log(`\n${colors.bold}${'═'.repeat(60)}`);
  console.log(`   📊 Test Summary`);
  console.log(`${'═'.repeat(60)}${colors.reset}\n`);
  
  console.log(`MongoDB: ${mongoSuccess ? `${colors.green}✅ PASS${colors.reset}` : `${colors.red}❌ FAIL${colors.reset}`}`);
  console.log(`Redis:   ${redisSuccess ? `${colors.green}✅ PASS${colors.reset}` : `${colors.red}❌ FAIL${colors.reset}`}`);
  
  if (mongoSuccess && redisSuccess) {
    console.log(`\n${colors.green}${colors.bold}🎉 All connections successful! Ready for production.${colors.reset}\n`);
    process.exit(0);
  } else {
    console.log(`\n${colors.yellow}⚠️  Some connections failed. Check configuration.${colors.reset}\n`);
    process.exit(1);
  }
}

main().catch(error => {
  console.error(`${colors.red}Fatal error:${colors.reset}`, error);
  process.exit(1);
});

