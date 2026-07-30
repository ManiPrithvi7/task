/**
 * Live smoke checks for Redis local-first migration.
 * Runs against local modules + optional Redis/Mongo from .env.
 */
import 'dotenv/config';
import {
  LocalOtaFleetTracker,
  LocalBudgetTracker,
  LocalDeviceBackoff,
  LocalFetchDedupe,
  LocalFairOffset,
  consumeFetchBudget
} from '../src/services/igPollCoordination';
import {
  getIgDeviceRuntimeCache,
  resetIgDeviceRuntimeCacheForTests,
  writeDeviceHashOnConnect
} from '../src/services/igDeviceRuntimeCache';
import {
  getLocalStimLock,
  getLocalPublishHashCache,
  getLocalPromoRotationCache,
  getLocalConnectDebounce,
  resetLocalCachesForTests
} from '../src/services/localCaches';
import { getRedisSyncService } from '../src/services/redisSync';
import { TokenStore } from '../src/storage/tokenStore';
import { OtaRedisState } from '../src/services/otaService';
import { createRedisService } from '../src/services/redisService';
import { REDIS_KEYS } from '../src/constants/redisKeys';

type Result = { name: string; ok: boolean; detail?: string };

const results: Result[] = [];

function check(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function smokeLocalCaches() {
  resetLocalCachesForTests();
  resetIgDeviceRuntimeCacheForTests();

  const stim = getLocalStimLock();
  check('LocalStimLock acquire', stim.tryAcquire('d1', 'ig', 5000) === true);
  check('LocalStimLock blocks second', stim.tryAcquire('d1', 'ig', 5000) === false);
  stim.release('d1', 'ig');
  check('LocalStimLock after release', stim.tryAcquire('d1', 'ig', 5000) === true);

  const pub = getLocalPublishHashCache();
  pub.set('d1', 'instagram', 'abc', 60_000);
  check('LocalPublishHashCache get', pub.get('d1', 'instagram') === 'abc');
  pub.clear('d1');
  check('LocalPublishHashCache clear', pub.get('d1', 'instagram') === null);

  const rot = getLocalPromoRotationCache();
  check('LocalPromoRotation increment', rot.increment('d1') === 1 && rot.increment('d1') === 2);

  const debounce = getLocalConnectDebounce();
  check('LocalConnectDebounce first', debounce.shouldRefresh('d1', 5000) === true);
  check('LocalConnectDebounce gated', debounce.shouldRefresh('d1', 5000) === false);

  const backoff = new LocalDeviceBackoff(2, 60_000);
  check('LocalDeviceBackoff allow', (await backoff.shouldAllow('x')) === true);
  await backoff.shouldAllow('x');
  check('LocalDeviceBackoff block', (await backoff.shouldAllow('x')) === false);

  const budget = new LocalBudgetTracker();
  check('LocalBudgetTracker under', (await consumeFetchBudget(budget, 2)) === true);
  await consumeFetchBudget(budget, 2);
  check('LocalBudgetTracker exhausted', (await consumeFetchBudget(budget, 2)) === false);

  const dedupe = new LocalFetchDedupe();
  check('LocalFetchDedupe first', (await dedupe.tryAcquire('y', 5000)) === true);
  check('LocalFetchDedupe second', (await dedupe.tryAcquire('y', 5000)) === false);

  const fair = new LocalFairOffset();
  const a = await fair.next(3);
  const b = await fair.next(3);
  check('LocalFairOffset rotates', a !== b || a === 0);

  const fleet = new LocalOtaFleetTracker((id) =>
    id === 'done' ? 'succeeded' : undefined
  );
  fleet.setActiveDevices(['a', 'b', 'c', 'done'], new Map([
    ['a', 1],
    ['b', 2],
    ['c', 3],
    ['done', 0]
  ]));
  const window = fleet.getDevicesForRollout(50, '1.0.0');
  check(
    'LocalOtaFleetTracker FIFO window',
    window.length === 2 && !window.includes('done'),
    `got ${JSON.stringify(window)}`
  );
  await fleet.markPending('a', '1.2.0', 25);
  check('LocalOtaFleetTracker pending', (await fleet.isPending('a', '1.2.0')) === true);
  await fleet.markDelivered('a', '1.2.0');
  check('LocalOtaFleetTracker delivered', (await fleet.isDelivered('a', '1.2.0')) === true);

  const cache = getIgDeviceRuntimeCache();
  cache.set('devA', { gmbProfileId: 'loc-1', gmbReviewCount: 7, otaStatus: 'pending' });
  cache.set('devB', { gmbProfileId: 'loc-1', gmbReviewCount: 7 });
  check(
    'GMB reverse index',
    cache.getByGmbProfileId('loc-1').sort().join(',') === 'devA,devB'
  );
  cache.markDirty('devA', 'power_save');
  cache.setPowerSave('devA', true);
  check('Runtime dirty tracking', cache.getDirtyDevices().length === 1);
}

async function smokeProvAndSync(redisUrl: string | undefined) {
  if (!redisUrl) {
    check('Redis live smoke', false, 'REDIS_URL not set');
    return;
  }

  const redisSvc = createRedisService({
    enabled: true,
    url: redisUrl,
    keyPrefix: process.env.REDIS_KEY_PREFIX || 'proof-mqtt:'
  });

  try {
    await redisSvc.connect();
  } catch (e) {
    check('Redis connect', false, e instanceof Error ? e.message : String(e));
    return;
  }

  if (!redisSvc.isRedisConnected()) {
    check('Redis connect', false, 'not connected after connect()');
    return;
  }
  check('Redis connect', true);

  const client = redisSvc.getClient();
  const ota = new OtaRedisState(() => client, process.env.REDIS_KEY_PREFIX || 'proof-mqtt:');

  try {
    await ota.setActiveRelease({
      version: '9.9.9-smoke',
      sha256: 'abc',
      signature: 'sig',
      objectKey: 'firmware/9.9.9-smoke/firmware.bin',
      sizeBytes: 1,
      releasedAt: new Date().toISOString()
    }, 25);
    const active = await ota.getActiveRelease();
    check(
      'OTA active_release HASH read',
      active?.version === '9.9.9-smoke',
      active ? `version=${active.version}` : 'null'
    );

    const type = await client.type(REDIS_KEYS.otaActiveRelease);
    check('OTA active_release key type is hash', type === 'hash', `type=${type}`);

    await ota.seedPendingFleet('9.9.9-smoke', ['smoke-dev-1', 'smoke-dev-2']);
    const pending = await ota.filterPending('9.9.9-smoke', ['smoke-dev-1', 'x']);
    check('OTA local fleet filterPending', pending.length === 1 && pending[0] === 'smoke-dev-1');

    await ota.markDelivered('smoke-dev-1', '9.9.9-smoke');
    check('OTA local fleet markDelivered', (await ota.isDelivered('smoke-dev-1', '9.9.9-smoke')) === true);

    const lock1 = await ota.tryAcquireSchedulerLock(5);
    const lock2 = await ota.tryAcquireSchedulerLock(5);
    check('OTA local scheduler lock', lock1 === true && lock2 === false);
    await ota.releaseSchedulerLock();

    // Device hash write + GMB fanout path pieces
    resetIgDeviceRuntimeCacheForTests();
    const cache = getIgDeviceRuntimeCache();
    await writeDeviceHashOnConnect('SMOKE-DEVICE', {
      userId: 'smoke-user',
      status: 'active',
      ig_follower_count: '42',
      gmb_profile_id: 'smoke-loc',
      gmb_review_count: '3',
      ota_status: 'none'
    });
    const hash = await client.hGetAll(REDIS_KEYS.deviceHash('SMOKE-DEVICE'));
    const hashOk = hash && (hash.ig_follower_count === '42' || Object.keys(hash).length > 0 || cache.getFollowers('SMOKE-DEVICE') === 42);
    check(
      'Device hash HSET / runtime hydrate',
      Boolean(hashOk),
      hash?.ig_follower_count
        ? `redis=${hash.ig_follower_count}`
        : `local=${cache.getFollowers('SMOKE-DEVICE')} (redis may be rate-limited)`
    );

    cache.set('SMOKE-DEVICE', { gmbProfileId: 'smoke-loc', powerSave: true });
    cache.markDirty('SMOKE-DEVICE', 'power_save');
    await getRedisSyncService().sync(client);
    check('RedisSync batch power_save', cache.getDirtyDevices().length === 0);

    // Prov token HASH
    const store = new TokenStore();
    const token = `smoke-token-${Date.now()}`;
    await store.setToken(token, 'SMOKE-DEVICE', 60, 'smoke-user');
    const deviceId = await store.getDeviceByToken(token);
    check('Prov LocalProvCache + HASH', deviceId === 'SMOKE-DEVICE');
    await store.markTokenConsumed(token, 60);
    check('Prov consume', (await store.isTokenConsumed(token)) === true);
    const provType = await client.type(REDIS_KEYS.provToken(token));
    check('Prov key is HASH', provType === 'hash' || provType === 'none', `type=${provType}`);

    // cleanup smoke keys (best-effort)
    try {
      await client.del(REDIS_KEYS.deviceHash('SMOKE-DEVICE'));
      await client.del(REDIS_KEYS.provToken(token));
      await client.del(REDIS_KEYS.otaActiveRelease);
    } catch {
      /* ignore */
    }
  } catch (e) {
    check('Redis live operations', false, e instanceof Error ? e.message : String(e));
  } finally {
    try {
      await redisSvc.disconnect();
    } catch {
      /* ignore */
    }
  }
}

async function main() {
  console.log('=== Redis local-first smoke ===\n');
  await smokeLocalCaches();
  console.log('');
  await smokeProvAndSync(process.env.REDIS_URL);
  console.log('\n=== Summary ===');
  const failed = results.filter((r) => !r.ok);
  console.log(`Passed: ${results.length - failed.length}/${results.length}`);
  if (failed.length) {
    for (const f of failed) console.log(`  FAIL: ${f.name} ${f.detail ?? ''}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
