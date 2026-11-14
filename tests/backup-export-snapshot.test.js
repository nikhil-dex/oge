import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('backup export requires current signed account version inside a transaction', async () => {
  const source = await readFile(new URL('../app/api/backup/route.js', import.meta.url), 'utf8');
  const exportRoute = source.slice(source.indexOf('export async function GET('), source.indexOf('export async function POST('));
  assert.match(exportRoute, /ownerMutationFilter\(ctx\.ownerId, \{ sessionVersion: ctx\.sessionVersion \}\)/);
  assert.match(exportRoute, /withAtomicBackupImport\(ctx\.db, async \(session\) =>/);
  assert.match(exportRoute, /findOne\(\s*accountFilter, \{ session, projection: \{ newsInterests: 1 \} \}/);
  assert.match(exportRoute, /if \(!user\) return null/);
  assert.match(exportRoute, /if \(!snapshot\) return json\(\{ error: 'Your account session has changed/);
  assert.doesNotMatch(exportRoute, /Promise\.all\(/);
});

test('backup export reads all owner collections using the same session with existing caps', async () => {
  const source = await readFile(new URL('../app/api/backup/route.js', import.meta.url), 'utf8');
  const exportRoute = source.slice(source.indexOf('export async function GET('), source.indexOf('export async function POST('));
  for (const collection of ['subjects', 'notes', 'savedLinks', 'quickNotes', 'personalQuickNotes']) {
    assert.ok(exportRoute.includes("collection('" + collection + "').find({ ownerId: ctx.ownerId }, { session })"), collection);
  }
  assert.equal((exportRoute.match(/\.limit\(5001\)\.toArray\(\)/g) || []).length, 5);
  assert.match(exportRoute, /records\.length > 5000/);
  assert.match(exportRoute, /'Cache-Control': 'private, no-store, max-age=0'/);
});
