import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { reconcileConfirmedVaultDraft } from '../lib/oge-vault-save-finalize.js';

const scope = { ownerId: 'b7-finalize-owner', repoId: 917, noteId: randomUUID() };
const revision = 6;
const blobSha = 'a'.repeat(40);
const commitSha = 'b'.repeat(40);

function fixture({ confirmed = true, returnedSha = blobSha, noteSha = blobSha,
  failure = false, cleared = true } = {}) {
  const calls = { reads: 0, checked: 0, deletes: 0 };
  const inspector = async (_drafts, _client, identity, requestedRevision) => {
    calls.checked++;
    assert.deepEqual(identity, scope);
    assert.equal(requestedRevision, revision);
    return confirmed
      ? { confirmed: true, sha: returnedSha, commitSha }
      : { confirmed: false, reason: 'draft-revision-changed' };
  };
  const noteReader = async (_client, id) => {
    calls.reads++;
    assert.equal(id, scope.noteId);
    if (failure) throw Error('GitHub temporarily unavailable');
    return { id, sha: noteSha, answer: 'private note',
      subjectId: randomUUID(), heading: 'Study' };
  };
  const clear = async (_drafts, identity, targetRevision) => {
    calls.deletes++;
    assert.deepEqual(identity, scope);
    assert.equal(targetRevision, revision);
    return cleared;
  };
  const client = { branch: 'main', vault: { repoId: scope.repoId } };
  return { calls, inspector, noteReader, clear, client };
}
const reconcile = (f, options = {}) => reconcileConfirmedVaultDraft(
  {}, f.client, scope, revision, blobSha, {
    inspector: f.inspector, noteReader: f.noteReader, clear: f.clear, ...options,
  });

test('B7 safely finalizes a confirmed Save once, returning the real GitHub note', async () => {
  const f = fixture();
  const result = await reconcile(f);
  assert.deepEqual({
    confirmed: result.confirmed, cleared: result.cleared,
    revision: result.revision, sha: result.sha, commitSha: result.commitSha,
    noteId: result.note.id,
  }, { confirmed: true, cleared: true, revision, sha: blobSha,
    commitSha, noteId: scope.noteId });
  assert.equal(f.calls.checked, 1);
  assert.equal(f.calls.reads, 1);
  assert.equal(f.calls.deletes, 1);
});

test('B7 never clears an unconfirmed or mismatched GitHub revision', async () => {
  for (const config of [
    { confirmed: false },
    { returnedSha: 'f'.repeat(40) },
    { noteSha: 'e'.repeat(40) },
    { failure: true },
  ]) {
    const f = fixture(config);
    const result = await reconcile(f);
    assert.equal(result.confirmed, false);
    assert.equal(result.cleared, false);
    assert.equal(f.calls.deletes, 0);
  }
});

test('B7 concurrent autosave with a newer revision causes CAS cleanup refusal', async () => {
  const f = fixture({ cleared: false });
  const result = await reconcile(f);
  assert.equal(result.confirmed, true);
  assert.equal(result.cleared, false);
  assert.equal(f.calls.deletes, 1);
});

test('B7 rejects tampered revision or proposed SHA before GitHub or draft operations', async () => {
  const f = fixture();
  await assert.rejects(reconcileConfirmedVaultDraft({}, f.client,
    scope, 0, blobSha, { inspector: f.inspector }), TypeError);
  await assert.rejects(reconcileConfirmedVaultDraft({}, f.client,
    scope, revision, 'not-a-sha', { inspector: f.inspector }), TypeError);
  assert.equal(f.calls.checked, 0);
});

test('B7 finalizer has no GitHub write, only conditional draft deletion', async () => {
  const source = await readFile(new URL('../lib/oge-vault-save-finalize.js', import.meta.url), 'utf8');
  const api = await readFile(new URL('../app/api/vault/drafts/route.js', import.meta.url), 'utf8');
  assert.match(source, /inspectVaultDraftGitHubSave/);
  assert.match(source, /clearConfirmedDraft/);
  assert.doesNotMatch(source, /method: 'POST'|method: 'PATCH'|saveVaultNote|commitVaultNoteBatch/);
  assert.match(api, /export async function POST\(request\)/);
  assert.match(api, /withVaultSubjectWrite/);
  assert.match(api, /reconcileConfirmedVaultDraft/);
  assert.match(api, /OGE_VAULT_HYBRID_DRAFT_PREVIEW/);
});
