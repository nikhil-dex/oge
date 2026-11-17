import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { VaultGitHubError } from '../lib/oge-vault-github.js';
import { verifyLessonNoteLinkReadOnly } from '../lib/oge-learning-track-note-links.js';

const record = { _id: 'link-1', noteId: 'c96a716d-125b-43e9-96dc-992a9b6d34cf' };
const verify = (overrides = {}) => {
  const events = [];
  const options = {
    record,
    createClient: async () => { events.push('client'); return { readOnly: true }; },
    readNote: async (client, noteId) => {
      events.push('note');
      assert.equal(client.readOnly, true);
      assert.equal(noteId, record.noteId);
      return { heading: 'PRIVATE', answer: 'NEVER LEAK' };
    },
    sessionStillActive: async () => { events.push('session'); return true; },
    rereadLink: async () => { events.push('link'); return { ...record }; },
    ...overrides,
  };
  return { events, check: () => verifyLessonNoteLinkReadOnly(options) };
};

test('M100 positive verification discards private content and rechecks session/link', async () => {
  const { check, events } = verify();
  assert.equal(await check(), 'present');
  assert.deepEqual(events, ['client', 'note', 'session', 'link']);
});

test('M100 a deleted GitHub Note is only a point-in-time missing observation', async () => {
  const { check } = verify({ readNote: async () => {
    throw new VaultGitHubError('not-found', 404);
  } });
  assert.equal(await check(), 'missing');
});

test('M100 provider outage, scope failures and rate limits must remain unknown', async () => {
  for (const code of [401, 403, 429, 500, 503]) {
    const error = new VaultGitHubError('provider-unavailable', code);
    const { check } = verify({ readNote: async () => { throw error; } });
    await assert.rejects(check(), (caught) => caught === error);
  }
  const setup = new VaultGitHubError('vault-not-connected', 404);
  const { check } = verify({ createClient: async () => { throw setup; } });
  await assert.rejects(check(), (caught) => caught === setup);
});

test('M100 session revocation suppresses verification after a provider read', async () => {
  const { check, events } = verify({ sessionStillActive: async () => {
    events.push('revoked'); return false;
  } });
  assert.equal(await check(), 'session-expired');
  assert.deepEqual(events, ['client', 'note', 'revoked']);
});

test('M100 concurrent unlink, relink and Note-ID substitution invalidate stale checks', async () => {
  for (const later of [null, { ...record, _id: 'link-2' },
    { ...record, noteId: 'd7c1f923-fae9-4665-b46f-4c3fe34f170f' }]) {
    const { check } = verify({ rereadLink: async () => later });
    assert.equal(await check(), 'changed');
  }
});

test('M100 explicit endpoint bounds owner reads, rejects stale session and never writes Notes', async () => {
  const route = await readFile(new URL('../app/api/learning-tracks/note-links/route.js', import.meta.url), 'utf8');
  const page = await readFile(new URL('../app/learning-tracks/page.js', import.meta.url), 'utf8');
  assert.match(route, /q\.get\('mode'\) === 'verify'/);
  assert.match(route, /scope: 'learning-track-note-check'/);
  assert.match(route, /limit: 8, windowMs: 3600000/);
  assert.match(route, /ownerId: ctx\.ownerId, trackId, videoId/);
  assert.match(route, /verifyLessonNoteLinkReadOnly/);
  assert.match(route, /ownerMutationFilter\(ctx\.ownerId, \{ sessionVersion: ctx\.sessionVersion \}\)/);
  assert.match(route, /\{ readOnly: true \}/);
  assert.match(route, /status === 'session-expired'/);
  assert.match(route, /status === 'changed'/);
  assert.match(page, /Verify linked Note/);
  assert.match(page, /Refresh Note links/);
  assert.match(page, /No longer found in your current Vault/);
  assert.match(page, /absent from this playlist snapshot/);
  assert.doesNotMatch(route, /saveVaultNote|commitVaultNoteBatch|method: 'PUT'/);
});
