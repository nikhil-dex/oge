import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { validatedNote } from '../lib/oge-vault-notes.js';
import {
  validateVaultNotesImportApproval, executeApprovedVaultNotesImport,
} from '../lib/oge-vault-backup-import-commit.js';
import { VaultGitHubError } from '../lib/oge-vault-github.js';

const sha = (value) => createHash('sha1').update(value).digest('hex');
const HEAD = sha('destination-head');
const TREE = sha('destination-tree');
const SUBJECT = randomUUID();
function archive(count = 2) {
  const notes = Array.from({ length: count }, (_, i) => ({
    ...validatedNote({ subjectId: SUBJECT, heading: 'Heading ' + i,
      answer: 'Private restored text ' + i, tags: [], favorite: false },
    { id: randomUUID(), now: '2026-11-15T08:00:00.000Z' }),
    sha: sha('source-file-' + i),
  }));
  return {
    format: 'oge-vault-notes-backup', version: 1,
    scope: 'current-github-notes-only',
    snapshot: sha('source-head'), totalNotes: notes.length,
    coverage: {
      notes: 'complete-at-snapshot', historicalRevisions: 'not-included',
      quickNotes: 'not-included', airNotes: 'not-included',
      encryptedDrafts: 'not-included', learningProgress: 'not-included',
    }, notes,
  };
}
function approval(input, ids = input.notes.map((item) => item.id).slice(0, 2)) {
  return {
    archive: input, expectedTargetHead: HEAD,
    selectedIds: ids, confirmation: 'IMPORT_SELECTED_NEW_NOTES',
  };
}
function fixture({ existing = [], pending = [], drift = false, rateLimit = false,
  ownerValid = true } = {}) {
  const calls = [];
  let refReads = 0;
  let writes = 0;
  const client = {
    branch: 'main', vault: { repoId: 34 },
    async call(path, options = {}) {
      calls.push({ path, method: options.method || 'GET' });
      if (rateLimit) throw new VaultGitHubError('github-rate-limited', 429);
      if (path === '/git/ref/heads/main') {
        refReads++;
        return { object: { sha: drift && refReads > 1 ? sha('new-head') : HEAD } };
      }
      if (path === '/git/commits/' + HEAD) return { tree: { sha: TREE } };
      if (path === '/git/trees/' + TREE + '?recursive=1') return {
        truncated: false, tree: [
          { path: 'notes', type: 'tree', sha: sha('notes') },
          ...existing.map((item) => ({
            path: 'notes/' + item.id + '.json', type: 'blob',
            mode: '100644', sha: sha('existing-' + item.id), size: 200,
          })),
        ],
      };
      throw Error('Unexpected endpoint ' + path);
    },
  };
  const options = {
    subjectVerifier: async () => true,
    pendingDraftIds: async () => [...pending],
    ownerVerifier: async () => ownerValid,
    beforeGitHubWrite: async () => {},
    batchWriter: async (_client, operations, opts) => {
      writes++;
      assert.equal(opts.expectedHead, HEAD);
      assert.equal(opts.preserveImportTimestamps, true);
      return { commitSha: sha('verified-import-commit'),
        results: operations.map((op) => ({
          action: 'create', ...op.note, sha: sha('new-' + op.id),
        })) };
    },
  };
  return { client, options, calls, getWrites: () => writes };
}

test('D3b2b1 exact owner approval only imports chosen creates; private content is not returned', async () => {
  const input = archive(4), request = approval(input);
  const verified = validateVaultNotesImportApproval(request);
  assert.deepEqual(verified.selectedIds, request.selectedIds);
  const f = fixture();
  const result = await executeApprovedVaultNotesImport(f.client, request, f.options);
  assert.deepEqual(result.importedIds, request.selectedIds);
  assert.equal(result.importedCount, 2);
  assert.equal(result.remainingArchiveNotes, 2);
  assert.equal(result.overwritePerformed, false);
  assert.equal(result.encryptedDraftsChanged, false);
  assert.equal(f.getWrites(), 1);
  assert.ok(f.calls.every((item) => item.method === 'GET'));
  assert.doesNotMatch(JSON.stringify(result), /Private restored text|Heading/);
});

test('D3b2b1 rejects absent, duplicate, wrong-head or unapproved note selections', () => {
  const input = archive(2), base = approval(input);
  for (const invalid of [
    { ...base, confirmation: 'yes' },
    { ...base, confirmation: undefined },
    { ...base, expectedTargetHead: '1'.repeat(39) },
    { ...base, selectedIds: [] },
    { ...base, selectedIds: [input.notes[0].id, input.notes[0].id] },
    { ...base, selectedIds: [randomUUID()] },
    { ...base, selectedIds: [input.notes[0].id.toUpperCase()] },
    { ...base, selectedIds: Array(13).fill(input.notes[0].id) },
    { ...base, extra: true },
  ]) assert.throws(() => validateVaultNotesImportApproval(invalid),
    (error) => error instanceof VaultGitHubError && error.status === 400);
});

test('D3b2b1 never commits conflicting GitHub IDs or encrypted drafts', async () => {
  const input = archive(3);
  for (const f of [
    fixture({ existing: [input.notes[0]] }),
    fixture({ pending: [input.notes[0].id] }),
    fixture({ drift: true }),
    fixture({ ownerValid: false }),
    fixture({ rateLimit: true }),
  ]) {
    await assert.rejects(() => executeApprovedVaultNotesImport(
      f.client, approval(input, [input.notes[0].id]), f.options));
    assert.equal(f.getWrites(), 0);
  }
});

test('D3b2b1 does not touch conflicts or drafts for non-selected notes', async () => {
  const input = archive(3);
  const f = fixture({ existing: [input.notes[0]], pending: [input.notes[1].id] });
  const result = await executeApprovedVaultNotesImport(f.client,
    approval(input, [input.notes[2].id]), f.options);
  assert.deepEqual(result.importedIds, [input.notes[2].id]);
  assert.equal(f.getWrites(), 1);
});

test('D3b2b1 missing owner verifier is a hard failure with zero import writes', async () => {
  const input = archive(1), f = fixture();
  await assert.rejects(executeApprovedVaultNotesImport(f.client,
    approval(input), { ...f.options, ownerVerifier: undefined }), TypeError);
  assert.equal(f.getWrites(), 0);
});

test('D3b2b1 501-note backup can select a single bounded atomic import batch', async () => {
  const input = archive(501), f = fixture();
  const result = await executeApprovedVaultNotesImport(f.client,
    approval(input, input.notes.slice(0, 12).map((note) => note.id)), f.options);
  assert.equal(result.importedCount, 12);
  assert.equal(result.remainingArchiveNotes, 489);
  assert.equal(f.getWrites(), 1);
});

test('D3b2b1 cannot report success if the GitHub writer returns unverified data', async () => {
  const input = archive(1), f = fixture();
  f.options.batchWriter = async () => ({
    commitSha: sha('commit'), results: [{ action: 'create', ...input.notes[0],
      answer: 'Not the approved content', sha: sha('file') }],
  });
  await assert.rejects(executeApprovedVaultNotesImport(f.client,
    approval(input, [input.notes[0].id]), f.options),
  (error) => error.message === 'vault-import-commit-unconfirmed' && error.status === 503);
});

test('D3b2b1 commit route is independent default-off and uses signed owner/draft/subject fences', async () => {
  const route = await readFile(new URL(
    '../app/api/vault/backup-import/commit/route.js', import.meta.url), 'utf8');
  assert.match(route, /OGE_VAULT_BACKUP_IMPORT_COMMIT_PREVIEW !== 'true'/);
  assert.match(route, /OGE_VAULT_BACKUP_IMPORT_PLAN_PREVIEW !== 'true'/);
  assert.match(route, /OGE_VAULT_NOTE_API_PREVIEW !== 'true'/);
  assert.match(route, /const session = await auth\(\)/);
  assert.match(route, /getVaultNoteClient\(db/);
  assert.match(route, /withVaultSubjectsWrite\(db, ownerId, subjectIds/);
  assert.match(route, /ownerMutationFilter\(ownerId, \{ sessionVersion \}\)/);
  assert.match(route, /vault_drafts/);
  assert.match(route, /slug: \{ \$in: chunk \}/);
  assert.match(route, /readLimitedBody/);
  assert.match(route, /private, no-store/);
  assert.doesNotMatch(route, /collection\(['"]notes['"]\)/);
  assert.doesNotMatch(route, /\.insertOne\(|\.deleteOne\(/);
});

test('D3b2b2c3 rejects GitHub mutation when the durable write marker cannot be recorded', async () => {
  const input = archive(1), f = fixture();
  let markerCalls = 0;
  await assert.rejects(executeApprovedVaultNotesImport(f.client,
    approval(input, [input.notes[0].id]), {
      ...f.options,
      beforeGitHubWrite: async (marker) => {
        markerCalls++;
        assert.match(marker, /^Restore OgeNotes backup [a-f0-9]{64}$/);
        throw new Error('synthetic MongoDB marker acknowledgement lost');
      },
    }), /synthetic MongoDB marker acknowledgement lost/);
  assert.equal(markerCalls, 1);
  assert.equal(f.getWrites(), 0);
});

test('D3b2b2c3 verified import hands its exact commit marker to the batch writer', async () => {
  const input = archive(2), f = fixture();
  let marked = null;
  f.options.beforeGitHubWrite = async (marker) => { marked = marker; };
  const original = f.options.batchWriter;
  f.options.batchWriter = async (client, operations, options) => {
    assert.equal(options.commitMessage, marked);
    return original(client, operations, options);
  };
  const result = await executeApprovedVaultNotesImport(f.client, approval(input), f.options);
  assert.equal(result.importedCount, 2);
  assert.equal(f.getWrites(), 1);
});

test('D3b2b2c3 import executor refuses to write if mandatory durable marker is absent', async () => {
  const input = archive(1), f = fixture();
  await assert.rejects(executeApprovedVaultNotesImport(
    f.client, approval(input, [input.notes[0].id]), {
      ...f.options, beforeGitHubWrite: undefined,
    }), TypeError);
  assert.equal(f.getWrites(), 0);
});

test('M51 owner revocation after durable marker blocks GitHub writer, never retries', async () => {
  const input = archive(1), f = fixture();
  let checks = 0, markerCalls = 0;
  const failure = executeApprovedVaultNotesImport(f.client,
    approval(input, [input.notes[0].id]), {
      ...f.options,
      ownerVerifier: async () => ++checks === 1,
      beforeGitHubWrite: async (marker, evidence) => {
        markerCalls++;
        assert.match(marker, /^Restore OgeNotes backup [a-f0-9]{64}$/);
        assert.equal(evidence.expectedHead, HEAD);
        assert.deepEqual(evidence.selectedIds, [input.notes[0].id]);
      },
    });
  await assert.rejects(failure, (err) =>
    err.status === 409 &&
    err.message === 'vault-import-owner-or-repository-changed-after-marker');
  assert.equal(checks, 2, 'second signed owner verifier happens after marker');
  assert.equal(markerCalls, 1);
  assert.equal(f.getWrites(), 0);
});

test('M51 account/repository verifier must pass both sides of durable GitHub marker', async () => {
  const input = archive(2), f = fixture();
  let checks = 0, markerStored = false;
  const result = await executeApprovedVaultNotesImport(
    f.client, approval(input), {
      ...f.options,
      ownerVerifier: async () => { checks++; return true; },
      beforeGitHubWrite: async () => { markerStored = true; },
      batchWriter: async (...args) => {
        assert.equal(markerStored, true);
        assert.equal(checks, 2, 'signed repo reverified just before GitHub writer');
        return f.options.batchWriter(...args);
      },
    });
  assert.equal(result.importedCount, 2);
  assert.equal(f.getWrites(), 1);
  assert.equal(checks, 2);
});

test('M51 refusal on second owner check cannot release possible-write lock in production route', async () => {
  const route = await readFile(new URL(
    '../app/api/vault/backup-import/commit/route.js', import.meta.url), 'utf8');
  const executor = await readFile(new URL(
    '../lib/oge-vault-backup-import-commit.js', import.meta.url), 'utf8');
  const fence = await readFile(new URL(
    '../lib/oge-vault-import-fence.js', import.meta.url), 'utf8');
  assert.match(route, /beforeGitHubWrite: markGitHubWriteAttempt/);
  assert.ok(executor.indexOf("throw fail('vault-import-owner-or-repository-changed-after-marker')") <
    executor.indexOf('await batchWriter(client, operations'));
  assert.ok(executor.indexOf('await beforeGitHubWrite(commitMessage') <
    executor.indexOf("throw fail('vault-import-owner-or-repository-changed-after-marker')"));
  assert.match(fence, /if \(workError && githubWriteMayHaveStarted\)/);
});
