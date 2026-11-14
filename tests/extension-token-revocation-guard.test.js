import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('extension token revocation is owner-scoped, throttled and cannot falsely succeed after deletion', async () => {
  const src = await readFile(new URL('../app/api/extension-token/route.js', import.meta.url), 'utf8');
  const revoke = src.slice(src.indexOf('export async function DELETE('));
  assert.match(revoke, /await owner\(\)/);
  assert.match(revoke, /scope: 'extension-token-revoke'/);
  assert.match(revoke, /identifier: ownerId, limit: 30, windowMs: 60 \* 60 \* 1000/);
  assert.match(revoke, /if \(!throttle\.allowed\) return rateLimitResponse\(throttle\)/);
  assert.match(revoke, /const accountFilter = ownerMutationFilter\(ownerId, \{ sessionVersion \}\)/);
  assert.match(revoke, /updateOne\(\s*accountFilter,/);
  assert.match(revoke, /\$unset: \{ extensionTokenHash:/);
  assert.match(revoke, /if \(result\.matchedCount !== 1\) return json\(\{ error:/);
  assert.ok(revoke.indexOf('if (result.matchedCount !== 1)') < revoke.indexOf('return json({ revoked: true })'));
});

test('token creation still checks user update before returning credential', async () => {
  const src = await readFile(new URL('../app/api/extension-token/route.js', import.meta.url), 'utf8');
  const create = src.slice(src.indexOf('export async function POST('), src.indexOf('export async function DELETE('));
  assert.match(create, /scope: 'extension-token-create'/);
  assert.match(create, /if \(result\.matchedCount !== 1\)/);
  assert.ok(create.indexOf('result.matchedCount !== 1') < create.indexOf('return json({ token,'));
});

test('extension creation and read are also fenced to signed account version', async () => {
  const src = await readFile(new URL('../app/api/extension-token/route.js', import.meta.url), 'utf8');
  assert.match(src, /sessionVersion: session\.user\.sessionVersion/);
  assert.equal((src.match(/ownerMutationFilter\(ownerId, \{ sessionVersion \}\)/g) || []).length, 3);
  assert.equal((src.match(/updateOne\(\s*accountFilter,/g) || []).length, 2);
  assert.match(src, /findOne\(accountFilter,/);
});
