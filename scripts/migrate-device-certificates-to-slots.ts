import mongoose from 'mongoose';

type DeviceCertSlot = 'primary' | 'staging';
type DeviceCertStatus = 'active' | 'revoked' | 'expired';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return v.trim();
}

function isUniqueDeviceIdIndex(idx: any): boolean {
  if (!idx || idx.unique !== true) return false;
  const key = idx.key || {};
  const keys = Object.keys(key);
  return keys.length === 1 && keys[0] === 'device_id' && key.device_id === 1;
}

async function main(): Promise<void> {
  const uri = requireEnv('MONGODB_URI');
  const dbName = process.env.MONGODB_DB_NAME?.trim() || undefined;

  // Use the same defaults as the app (short selection timeout, no buffering).
  await mongoose.connect(uri, {
    dbName,
    maxPoolSize: 5,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
    bufferCommands: false
  });

  try {
    const db = mongoose.connection.db;
    if (!db) throw new Error('MongoDB db handle not available');

    const coll = db.collection('device_certificates');

    // Step A: backfill slot='primary' where missing
    const backfill = await coll.updateMany(
      { slot: { $exists: false } },
      { $set: { slot: 'primary' satisfies DeviceCertSlot } }
    );
    console.log('[migrate] Backfilled slot', {
      matched: backfill.matchedCount,
      modified: backfill.modifiedCount
    });

    // Step B: drop unique index on device_id (discover names dynamically)
    const indexes = await coll.indexes();
    const deviceIdUnique = indexes.filter(isUniqueDeviceIdIndex);
    if (deviceIdUnique.length === 0) {
      console.log('[migrate] No unique index on {device_id:1} found (ok)');
    } else {
      for (const idx of deviceIdUnique) {
        console.log('[migrate] Dropping unique index', { name: idx.name, key: idx.key });
        await coll.dropIndex(idx.name);
      }
    }

    // Step C: ensure compound indexes for slot lookups
    const idx1 = await coll.createIndex(
      { device_id: 1, slot: 1, status: 1 },
      { name: 'device_id_slot_status' }
    );
    const idx2 = await coll.createIndex(
      { device_id: 1, slot: 1, expires_at: 1 },
      { name: 'device_id_slot_expires_at' }
    );
    console.log('[migrate] Ensured indexes', { idx1, idx2 });

    // Step D: validate no duplicates for active primary/staging per device_id
    const dupes = await coll
      .aggregate([
        {
          $match: {
            status: 'active' satisfies DeviceCertStatus,
            slot: { $in: ['primary', 'staging'] satisfies DeviceCertSlot[] }
          }
        },
        {
          $group: {
            _id: { device_id: '$device_id', slot: '$slot' },
            count: { $sum: 1 },
            fingerprints: { $addToSet: '$fingerprint' }
          }
        },
        { $match: { count: { $gt: 1 } } }
      ])
      .toArray();

    if (dupes.length > 0) {
      console.error('[migrate] CRITICAL: found duplicate active certs per device_id+slot');
      for (const d of dupes) {
        console.error(
          JSON.stringify(
            {
              device_id: d._id?.device_id,
              slot: d._id?.slot,
              count: d.count,
              fingerprints: d.fingerprints
            },
            null,
            2
          )
        );
      }
      process.exitCode = 2;
      return;
    }

    console.log('[migrate] OK: no duplicate active primary/staging certs found');
  } finally {
    await mongoose.disconnect().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error('[migrate] ERROR', err instanceof Error ? err.message : err);
  process.exit(1);
});

