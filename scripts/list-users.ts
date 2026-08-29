/**
 * List all users in the MongoDB `User` collection (read-only diagnostic).
 *
 * Context: POST /api/v1/onboarding looks users up strictly by _id
 * (User.findById), so a JWT carrying a foreign user ID 404s even when the
 * same email exists under a different _id. This script lists every user so
 * you can spot the same email living under two different _ids.
 *
 * Usage: bun scripts/list-users.ts [email-filter]
 */

import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { mongoDriverTimeouts } from '../src/config/mongoConnection';

dotenv.config();

async function main(): Promise<void> {
  const uri = (process.env.MONGODB_URI || process.env.MONGO_URI || '').trim();
  const dbName = (process.env.MONGODB_DB_NAME || 'statsmqtt').trim();
  const emailFilter = process.argv[2]?.trim().toLowerCase();

  if (!uri) {
    console.error('FAIL: MONGODB_URI (or MONGO_URI) is missing.');
    process.exit(1);
  }

  await mongoose.connect(uri, {
    dbName,
    maxPoolSize: 5,
    ...mongoDriverTimeouts(),
    bufferCommands: false
  });

  const db = mongoose.connection.db;
  if (!db) {
    console.error('FAIL: No database handle after connect.');
    process.exit(1);
  }

  const users = await db
    .collection('User')
    .find({}, { projection: { password: 0 } })
    .sort({ createdAt: 1 })
    .toArray();

  console.log(`DB: ${dbName} — ${users.length} user(s) in "User" collection\n`);

  const byEmail = new Map<string, string[]>();

  for (const u of users) {
    const id = String(u._id);
    const email = (u.email as string | undefined) ?? '(no email)';
    if (emailFilter && !email.toLowerCase().includes(emailFilter)) continue;

    console.log(`_id:       ${id}`);
    console.log(`email:     ${email}`);
    console.log(`name:      ${(u.name as string | undefined) ?? '(none)'}`);
    console.log(`createdAt: ${u.createdAt ? new Date(u.createdAt).toISOString() : '(none)'}`);
    console.log('---');

    const key = email.toLowerCase();
    byEmail.set(key, [...(byEmail.get(key) ?? []), id]);
  }

  const duplicates = [...byEmail.entries()].filter(
    ([email, ids]) => email !== '(no email)' && ids.length > 1
  );
  if (duplicates.length > 0) {
    console.log('\nSame email under multiple _ids (root cause of USER_NOT_FOUND mismatches):');
    for (const [email, ids] of duplicates) {
      console.log(`  ${email}: ${ids.join(', ')}`);
    }
  }

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('FAIL:', e instanceof Error ? e.message : String(e));
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
