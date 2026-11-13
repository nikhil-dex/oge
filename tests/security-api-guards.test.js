import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Gemini key action is validated before provider verification', async () => {
  const source = await readFile(new URL('../app/api/gemini-key/route.js', import.meta.url), 'utf8');
  const validation = source.indexOf("if (!['save', 'test', 'delete'].includes(action))");
  const verification = source.indexOf('await verifyGeminiKey(apiKey)');
  assert.ok(validation > -1);
  assert.ok(verification > validation);
  assert.ok(!source.includes('payload.error.message'), 'untrusted provider errors should not be reflected');
});

test('backup exports apply a finite per-collection record cap', async () => {
  const source = await readFile(new URL('../app/api/backup/route.js', import.meta.url), 'utf8');
  for (const name of ['subjects', 'notes', 'savedLinks', 'quickNotes']) {
    const line = source.split('\n').find((entry) => entry.includes("db.collection('" + name + "').find({ ownerId: ctx.ownerId })"));
    assert.ok(line?.includes('.limit(5001).toArray()'), name + ' export must be capped');
  }
  assert.match(source, /records.length > 5000/);
  assert.ok(source.includes('Could not process this backup request.'));
});
