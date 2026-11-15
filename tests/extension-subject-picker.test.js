import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('extension subject listing is read-only, token-scoped and owner-scoped', async () => {
  const route = await readFile(new URL('../app/api/extension/subjects/route.js', import.meta.url), 'utf8');
  const proxy = await readFile(new URL('../proxy.js', import.meta.url), 'utf8');
  assert.match(route, /export async function GET\(request\)/);
  assert.doesNotMatch(route, /export async function POST/);
  assert.match(route, /hashExtensionToken\(token\)/);
  assert.match(route, /extensionTokenExpiresAt: \{ \$gt: new Date\(\) \}/);
  assert.match(route, /find\(\{ ownerId: user\.googleSub \}/);
  assert.match(route, /projection: \{ _id: 0, slug: 1, name: 1 \}/);
  assert.match(proxy, /pathname === '\/api\/extension\/subjects'/);
});

test('subject notes retain first-line title, remainder as answer and Notes schema', async () => {
  const route = await readFile(new URL('../app/api/extension/quick-note/route.js', import.meta.url), 'utf8');
  assert.match(route, /content\.indexOf\('\\n'\)/);
  assert.match(route, /heading = \(breakAt < 0 \? content : content\.slice\(0, breakAt\)\)\.trim\(\)/);
  assert.match(route, /answer = breakAt < 0 \? '' : content\.slice\(breakAt \+ 1\)\.trim\(\)/);
  assert.match(route, /heading\.length > 160/);
  assert.match(route, /collection\('subjects'\)\.findOne\(/);
  assert.match(route, /ownerId: user\.googleSub, slug: subjectSlug/);
  assert.match(route, /collection\('notes'\)\.insertOne\(note, \{ session \}\)/);
  assert.match(route, /subjectSlug, heading, answer, tags: \[\]/);
  assert.match(route, /destination: 'notes'/);
  assert.match(route, /collection\('quickNotes'\)\.insertOne\(note, \{ session \}\)/);
  assert.match(route, /destination: 'quick-notes'/);
});

test('floating editor provides subject dropdown and preserves default Quick Notes', async () => {
  const content = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
  const worker = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
  assert.match(content, /id="oge-note-subject"/);
  assert.match(content, /Quick Notes \(default\)/);
  assert.match(content, /send\('GET_SUBJECTS'\)/);
  assert.match(content, /content: note\.value, subjectSlug: subjectSelect\.value/);
  assert.match(content, /option\.textContent = subject\.name/);
  assert.match(content, /option\.value = subject\.slug/);
  assert.match(worker, /'GET_SUBJECTS'/);
  assert.match(worker, /'\/api\/extension\/subjects'/);
  assert.match(worker, /JSON\.stringify\(\{ content, subjectSlug \}\)/);
  assert.doesNotMatch(content, /Bearer /);
});
