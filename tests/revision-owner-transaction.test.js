import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('revision rating and history restoration mutate only in a live owner transaction', async () => {
  const rating = await readFile(new URL('../app/api/revision/route.js', import.meta.url), 'utf8');
  const history = await readFile(new URL('../app/api/revision-history/route.js', import.meta.url), 'utf8');
  for (const [name, source] of [['revision rating', rating], ['history restore', history]]) {
    const mutation = source.slice(source.indexOf('export async function POST('));
    assert.match(mutation, /withActiveOwnerMutation\(db, ownerId, async \(session\) =>/,
      name + ' must guard account existence');
    assert.match(mutation, /findOneAndUpdate\([\s\S]*?session \}/,
      name + ' must commit note update within owner transaction');
  }
  assert.match(history, /findOne\(\{ _id: new ObjectId\(noteId\), ownerId \}, \{ session \}\)/);
  assert.match(history, /restoreFilter\.updatedAt/);
});

test('account credential creation must not claim success if owning user was deleted', async () => {
  const extension = await readFile(new URL('../app/api/extension-token/route.js', import.meta.url), 'utf8');
  const gemini = await readFile(new URL('../app/api/gemini-key/route.js', import.meta.url), 'utf8');
  const interests = await readFile(new URL('../app/onboarding/actions.js', import.meta.url), 'utf8');
  assert.match(extension.slice(extension.indexOf('export async function POST(')), /result\.matchedCount !== 1[\s\S]*?return json\(\{ token/);
  assert.match(gemini, /result\.matchedCount !== 1/g);
  assert.ok((gemini.match(/result\.matchedCount !== 1/g) || []).length >= 2,
    'both Gemini key save and delete must check account row');
  assert.match(interests, /if \(result\.matchedCount !== 1\) redirect\('\/register'\)/);
});
