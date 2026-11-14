import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('settings and credentials mutate only the signed account incarnation', async () => {
  const extension = await readFile(new URL('../app/api/extension-token/route.js', import.meta.url), 'utf8');
  const gemini = await readFile(new URL('../app/api/gemini-key/route.js', import.meta.url), 'utf8');
  const onboarding = await readFile(new URL('../app/onboarding/actions.js', import.meta.url), 'utf8');

  assert.match(extension, /sessionVersion: session\.user\.sessionVersion/);
  assert.match(extension, /ownerMutationFilter\(ownerId, \{ sessionVersion \}\)/);
  assert.equal((extension.match(/updateOne\(\s*accountFilter,/g) || []).length, 2);

  assert.match(gemini, /sessionVersion: session\.user\.sessionVersion/);
  assert.match(gemini, /ownerMutationFilter\(ctx\.ownerId, \{ sessionVersion: ctx\.sessionVersion \}\)/);
  assert.equal((gemini.match(/users\.updateOne\(accountFilter,/g) || []).length, 2);

  assert.match(onboarding, /ownerMutationFilter\(ownerId, \{ sessionVersion: session\.user\.sessionVersion \}\)/);
  assert.match(onboarding, /updateOne\(\s*accountFilter,/);
});

test('credential endpoint retains restrictive rate limits and no user-provided account version', async () => {
  const extension = await readFile(new URL('../app/api/extension-token/route.js', import.meta.url), 'utf8');
  const gemini = await readFile(new URL('../app/api/gemini-key/route.js', import.meta.url), 'utf8');
  assert.match(extension, /scope: 'extension-token-create'/);
  assert.match(extension, /scope: 'extension-token-revoke'/);
  assert.match(gemini, /scope: 'gemini-key-update'/);
  assert.doesNotMatch(extension, /request\.json\(\)[\s\S]*sessionVersion/);
  assert.doesNotMatch(gemini, /data\?\.sessionVersion/);
});
