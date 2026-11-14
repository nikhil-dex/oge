import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ownerMutationFilter } from '../lib/active-owner-mutation.js';

const oldVersion = '16968e8f-e95f-4419-af46-ac058595bb9a';
const newVersion = '4de7455b-c9b7-468f-ac20-588eb815890a';

test('private account-read filter rejects replacement account incarnation', () => {
  const old = ownerMutationFilter('google-sub-1', { sessionVersion: oldVersion });
  const replacement = { googleSub: 'google-sub-1', sessionVersion: newVersion };
  assert.equal(old.googleSub, replacement.googleSub);
  assert.notEqual(old.sessionVersion, replacement.sessionVersion);
  assert.deepEqual(ownerMutationFilter('google-sub-1', { sessionVersion: 0 }), {
    googleSub: 'google-sub-1',
    $or: [{ sessionVersion: 0 }, { sessionVersion: { $exists: false } }],
  });
});

test('Gemini key status requires the original signed account incarnation', async () => {
  const source = await readFile(new URL('../app/api/gemini-key/route.js', import.meta.url), 'utf8');
  const getter = source.slice(source.indexOf('export async function GET('), source.indexOf('export async function POST('));
  assert.match(getter, /ownerMutationFilter\(ctx\.ownerId, \{ sessionVersion: ctx\.sessionVersion \}\)/);
  assert.match(getter, /findOne\(\s*accountFilter,/);
  assert.match(getter, /if \(!user\) return json\(/);
});

test('extension status refuses to report a replacement account as disconnected', async () => {
  const source = await readFile(new URL('../app/api/extension-token/route.js', import.meta.url), 'utf8');
  const getter = source.slice(source.indexOf('export async function GET('), source.indexOf('export async function POST('));
  assert.match(getter, /findOne\(accountFilter,/);
  assert.match(getter, /if \(!user\) return json\(/);
  assert.match(getter, /status: 'unused-placeholder'|return json\(\{ connected: active/);
});

test('personalized news and Settings use signed account versions for profile reads', async () => {
  const news = await readFile(new URL('../app/api/news/route.js', import.meta.url), 'utf8');
  const settings = await readFile(new URL('../app/settings/page.js', import.meta.url), 'utf8');
  assert.match(news, /ownerMutationFilter\(ownerId, \{ sessionVersion: session\.user\.sessionVersion \}\)/);
  assert.match(news, /findOne\(accountFilter,/);
  assert.match(news, /if \(!account\) return Response\.json\(/);
  assert.match(settings, /ownerMutationFilter\(ownerId, \{ sessionVersion: session\.user\.sessionVersion \}\)/);
  assert.match(settings, /findOne\(\s*accountFilter,/);
  assert.match(settings, /if \(!user\) redirect\('\/register'\)/);
});
