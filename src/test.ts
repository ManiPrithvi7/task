import assert from 'assert';
import {
  atomicBackoffCheckAndRecordLua,
  atomicPriorityReadAndPruneLua
} from './services/instagramService';

function nonEmptyString(name: string, value: unknown): void {
  assert.strictEqual(typeof value, 'string', `${name} must be a string`);
  assert.ok((value as string).trim().length > 0, `${name} must be non-empty`);
}

nonEmptyString('atomicPriorityReadAndPruneLua', atomicPriorityReadAndPruneLua);
nonEmptyString('atomicBackoffCheckAndRecordLua', atomicBackoffCheckAndRecordLua);

assert.ok(atomicPriorityReadAndPruneLua.includes('ZRANGEBYSCORE'), 'priority script should read zset');
assert.ok(atomicPriorityReadAndPruneLua.includes('ZREMRANGEBYSCORE'), 'priority script should prune zset');
assert.ok(atomicBackoffCheckAndRecordLua.includes('ZCOUNT'), 'backoff script should count window');

console.log('OK');

