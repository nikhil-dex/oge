import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { learningTrackNoteLinksEnabled, validLearningTrackNoteSelection,
  publicLessonNoteLink } from '../lib/oge-learning-track-note-links.js';
import { ACCOUNT_OWNER_COLLECTIONS } from '../lib/account-deletion-transaction.js';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const trackId = '9b044299-28c7-44ad-9d66-3f6b77e956a4';
const noteId = 'c96a716d-125b-43e9-96dc-992a9b6d34cf';

test('M99 link preview is separately gated and disabled without verified staging', () => {
  assert.equal(learningTrackNoteLinksEnabled({}), false);
  assert.equal(learningTrackNoteLinksEnabled({
    OGE_LEARNING_TRACK_NOTE_LINK_PREVIEW: 'true', OGE_LEARNING_TRACKS_PREVIEW: 'true',
    OGE_VAULT_MAIN_PREVIEW: 'true', OGE_VAULT_NOTE_API_PREVIEW: 'true',
    OGE_VAULT_HYBRID_DRAFT_PREVIEW: 'true', MONGODB_DB: 'oge_notes',
  }), false);
});
test('M99 link metadata contains only owner-selected IDs, never private content', () => {
  const sel = { trackId, noteId, videoId: 'abc12345678' };
  assert.equal(validLearningTrackNoteSelection(sel), true);
  for (const invalid of [
    { ...sel, videoId: 'javascript:' }, { ...sel, trackId: 'bad' },
    { ...sel, noteId: 'not-a-uuid' }, { ...sel, videoId: '../private' },
    { trackId, videoId: 'abc12345678' },
  ]) assert.equal(validLearningTrackNoteSelection(invalid), false);
  assert.deepEqual(publicLessonNoteLink({ ...sel, ownerId: 'secret-owner',
    heading: 'PRIVATE TITLE', answer: 'PRIVATE BODY', linkedAt: 'today' }),
  { ...sel, linkedAt: 'today' });
});
test('M99 route requires owner session, read-only GitHub verified Note, active owner transaction', async () => {
  const route = await read('../app/api/learning-tracks/note-links/route.js');
  assert.match(route, /learningTrackNoteLinksEnabled\(\)/);
  assert.match(route, /await auth\(\)/);
  assert.match(route, /ownerId: ctx\.ownerId/);
  assert.match(route, /getVaultNoteClient/);
  assert.match(route, /\{ readOnly: true \}/);
  assert.match(route, /await readVaultNote\(client, data\.noteId\)/);
  assert.match(route, /withActiveOwnerMutation/);
  assert.match(route, /sessionVersion: ctx\.sessionVersion/);
  assert.match(route, /Unlink the existing Note/);
  assert.doesNotMatch(route, /saveVaultNote|commitVaultNoteBatch|method: 'PUT'|collection\(['"]notes['"]\)/);
});
test('M99 track/account deletion clean up only metadata links and indexes enforce uniqueness', async () => {
  const tracks = await read('../app/api/learning-tracks/route.js');
  const db = await read('../lib/mongodb.js');
  assert.match(tracks, /learningTrackNoteLinks'\)\.deleteMany/);
  assert.match(db, /learningTrackNoteLinks'\)\.createIndex\(\{ ownerId: 1, trackId: 1, videoId: 1 \}, \{ unique: true \}/);
  assert.ok(ACCOUNT_OWNER_COLLECTIONS.includes('learningTrackNoteLinks'));
});
test('M99 web UI and extension hand off explicitly, without URL note-content payloads', async () => {
  const page = await read('../app/learning-tracks/page.js');
  const worker = await read('../extension/service-worker.js');
  const content = await read('../extension/content.js');
  assert.match(page, /Link existing Note/);
  assert.match(page, /Copy for Quick Capture/);
  assert.match(page, /navigator\.clipboard\.writeText/);
  assert.match(page, /href="\/vault\/capture"/);
  assert.match(worker, /OPEN_LEARNING_TRACKS/);
  assert.match(worker, /origin \+ '\/learning-tracks'/);
  assert.match(content, /data-open-learning-tracks/);
});
