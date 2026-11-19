import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { inspectVaultDraftGitHubSave } from '../lib/oge-vault-save-recovery.js';

const identity = { ownerId: 'b7-owner', repoId: 72, noteId: randomUUID() };
const subjectId = randomUUID();
const sha = (c) => c.repeat(40);
const head = sha('a'), treeSha = sha('b'), noteSha = sha('c'), oldSha = sha('d');
const expected = { subjectId, heading: 'Study heading ', answer: 'Content body ',
  tags: ['web', 'security'], favorite: false, baseSha: oldSha };

function fixture({ draft = expected, revision = 7, blob = {},
  trunk = head, truncated = false, advanced = false, missing = false,
  duplicate = false } = {}) {
  let reads = 0;
  let draftReads = 0;
  let writes = 0;
  const draftReader = async () => {
    draftReads++;
    if (advanced && draftReads > 1) return { revision: 8, draft };
    return { revision, draft };
  };
  const blobReader = async (_client, id, hash) => {
    assert.equal(id, identity.noteId);
    assert.equal(hash, noteSha);
    reads++;
    return { id, sha: hash, subjectId, heading: 'Study heading',
      answer: 'Content body', tags: ['web', 'security'], favorite: false, ...blob };
  };
  const client = { branch: 'main', vault: { repoId: identity.repoId },
    async call(path) {
      if (path === '/git/ref/heads/main')
        return { object: { sha: trunk } };
      if (path === '/git/commits/' + head) return { tree: { sha: treeSha } };
      if (path === '/git/trees/' + treeSha + '?recursive=1')
        return { truncated, tree: missing ? [] : [
          { path: 'notes/' + identity.noteId + '.json', type: 'blob', sha: noteSha },
          ...(duplicate ? [{ path: 'notes/' + identity.noteId + '.json',
            type: 'blob', sha: noteSha }] : []),
        ] };
      throw Error('Unexpected GitHub request ' + path);
    },
  };
  const drafts = { async deleteOne() { writes++; throw Error('Must not clear drafts'); } };
  return { client, drafts, draftReader, blobReader,
    get blobReads() { return reads; },
    get draftReads() { return draftReads; },
    get writes() { return writes; },
  };
}

async function inspect(f, opts = {}) {
  return inspectVaultDraftGitHubSave(f.drafts, f.client, identity, 7,
    { draftReader: f.draftReader, blobReader: f.blobReader, ...opts });
}

test('B7 confirms exact revision and GitHub immutable blob without mutating drafts', async () => {
  const f = fixture();
  assert.deepEqual(await inspect(f), { confirmed: true, revision: 7,
    sha: noteSha, commitSha: head, advisoryOnly: true });
  assert.equal(f.blobReads, 1);
  assert.equal(f.draftReads, 2);
  assert.equal(f.writes, 0);
});

test('B7 never confirms a newer draft or a different remote note', async () => {
  const changed = fixture({ advanced: true });
  assert.equal((await inspect(changed)).reason, 'draft-revision-changed');
  const mismatchedRevision = fixture({ revision: 8 });
  assert.equal((await inspect(mismatchedRevision)).reason, 'draft-revision-changed');
  assert.equal(mismatchedRevision.blobReads, 0);
  const mismatchedContent = fixture({ blob: { answer: 'Other device content' } });
  assert.equal((await inspect(mismatchedContent)).reason, 'github-content-mismatch');
  const mismatchedTags = fixture({ blob: { tags: ['security', 'web'] } });
  assert.equal((await inspect(mismatchedTags)).reason, 'github-content-mismatch');
});

test('B7 rejects stale remote SHA, missing file, duplicate tree and truncated tree', async () => {
  const sameSha = fixture({ draft: { ...expected, baseSha: noteSha } });
  assert.equal((await inspect(sameSha)).reason, 'github-revision-unchanged');
  const missing = fixture({ missing: true });
  assert.equal((await inspect(missing)).reason, 'github-note-unavailable');
  const duplicate = fixture({ duplicate: true });
  assert.equal((await inspect(duplicate)).reason, 'github-note-unavailable');
  const incomplete = fixture({ truncated: true });
  assert.equal((await inspect(incomplete)).reason, 'github-tree-incomplete');
});

test('B7 fails closed for wrong repository or invalid Save revision', async () => {
  const f = fixture();
  await assert.rejects(inspectVaultDraftGitHubSave(f.drafts,
    { ...f.client, vault: { repoId: 73 } }, identity, 7,
    { draftReader: f.draftReader, blobReader: f.blobReader }),
  /vault-save-recovery-repository-mismatch/);
  await assert.rejects(inspectVaultDraftGitHubSave(f.drafts,
    f.client, identity, 0, { draftReader: f.draftReader }),
  /Invalid Save recovery revision/);
});

test('B7 recovery never clears drafts or exposes a production notes endpoint', async () => {
  const code = await readFile(new URL('../lib/oge-vault-save-recovery.js', import.meta.url), 'utf8');
  const route = await readFile(new URL('../app/api/vault/drafts/route.js', import.meta.url), 'utf8');
  const production = await readFile(new URL('../app/api/notes/route.js', import.meta.url), 'utf8');
  assert.doesNotMatch(code, /deleteOne\(|deleteMany\(|updateOne\(|insertOne\(/);
  assert.match(route, /params\.get\('confirm'\) === 'true'/);
  assert.match(route, /inspectVaultDraftGitHubSave/);
  assert.match(route, /OGE_VAULT_HYBRID_DRAFT_PREVIEW !== 'true'/);
  assert.match(route, /checkOwnerMutationLimit/);
  assert.doesNotMatch(production, /inspectVaultDraftGitHubSave/);
});
