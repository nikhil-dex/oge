import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { validatedNote } from '../lib/oge-vault-notes.js';
import {
  validateVaultNotesImportArchive, planVaultNotesImport,
} from '../lib/oge-vault-backup-import-plan.js';
import { VaultGitHubError } from '../lib/oge-vault-github.js';

const sha = (text) => createHash('sha1').update(text).digest('hex');
const subjectId = randomUUID();
const targetHead = sha('target'), treeSha = sha('target-tree');
function archive(count = 3) {
  const notes = Array.from({ length: count }, (_, i) => ({
    ...validatedNote({ subjectId, heading: 'Private heading ' + i,
      answer: 'Private content ' + i, favorite: false, tags: [] },
    { id: randomUUID(), now: '2026-11-16T00:00:00.000Z' }),
    sha: sha('untrusted-source-sha-' + i),
  }));
  return {
    format: 'oge-vault-notes-backup', version: 1,
    scope: 'current-github-notes-only', snapshot: sha('source-head'),
    totalNotes: notes.length,
    coverage: {
      notes: 'complete-at-snapshot', historicalRevisions: 'not-included',
      quickNotes: 'not-included', airNotes: 'not-included',
      encryptedDrafts: 'not-included', learningProgress: 'not-included',
    }, notes,
  };
}

function githubFixture({ existing = [], truncated = false, changedHead = false,
  customTree, errorAt } = {}) {
  const calls = [];
  let headCalls = 0;
  const client = {
    branch: 'main', vault: { repoId: 37 },
    async call(path, opts = {}) {
      calls.push({ path, method: opts.method || 'GET' });
      if (errorAt && path.includes(errorAt)) throw new VaultGitHubError('github-rate-limited', 429);
      if (path === '/git/ref/heads/main') return { object: {
        sha: changedHead && ++headCalls > 1 ? sha('drift') : targetHead,
      } };
      if (path === '/git/commits/' + targetHead) return { tree: { sha: treeSha } };
      if (path === '/git/trees/' + treeSha + '?recursive=1')
        return { truncated, tree: customTree ?? [
          { path: 'notes', type: 'tree', sha: sha('notes-dir') },
          ...existing.map((item) => ({
            path: 'notes/' + item.id + '.json', type: 'blob',
            mode: '100644', sha: sha('target-blob-' + item.id), size: 256,
          })),
        ] };
      throw new Error('Unexpected path ' + path);
    },
  };
  return { client, calls };
}

const plan = (client, uploaded, opts = {}) =>
  planVaultNotesImport(client, uploaded, {
    subjectVerifier: async () => true,
    pendingDraftIds: async () => [],
    ...opts,
  });

test('D3b2 canonical Notes export is validated, but source SHA never grants write permission', async () => {
  const input = archive(2);
  const parsed = validateVaultNotesImportArchive(input);
  assert.equal(parsed.notes.length, 2);
  assert.ok(parsed.notes.every((note) => !Object.hasOwn(note, 'sha')));
  const f = githubFixture();
  const result = await plan(f.client, input);
  assert.equal(result.readOnly, true);
  assert.equal(result.advisoryOnly, true);
  assert.equal(result.canCommit, false);
  assert.equal(result.requiresFreshApproval, true);
  assert.equal(result.sourceShaTrusted, false);
  assert.equal(result.targetHead, targetHead);
  assert.deepEqual(result.summary, {
    total: 2, createCandidates: 2, existingConflicts: 0, draftConflicts: 0,
  });
  assert.ok(result.entries.every((entry) => entry.outcome === 'create-candidate'));
  assert.ok(f.calls.every((entry) => entry.method === 'GET'));
  assert.equal(JSON.stringify(result).includes('Private heading'), false);
  assert.equal(JSON.stringify(result).includes('Private content'), false);
});

test('D3b2 accepts semantically canonical backups when note JSON keys are reordered', () => {
  const uploaded = archive(1);
  const [raw] = uploaded.notes;
  uploaded.notes[0] = Object.fromEntries(
    Object.entries(raw).reverse(),
  );
  const checked = validateVaultNotesImportArchive(uploaded);
  assert.equal(checked.notes[0].id, raw.id);
  assert.equal(checked.notes[0].answer, raw.answer);
});

test('D3b2 existing GitHub IDs always require conflict review, even with plausible source SHAs', async () => {
  const input = archive(3);
  const f = githubFixture({ existing: [input.notes[0], input.notes[1]] });
  const result = await plan(f.client, input);
  assert.deepEqual(result.summary, {
    total: 3, createCandidates: 1, existingConflicts: 2, draftConflicts: 0,
  });
  assert.equal(result.entries[0].outcome, 'existing-note-conflict');
  assert.equal(result.entries[2].outcome, 'create-candidate');
});

test('D3b2 encrypted drafts take precedence over existing or missing GitHub notes', async () => {
  const input = archive(3);
  const f = githubFixture({ existing: [input.notes[0]] });
  const result = await plan(f.client, input, {
    pendingDraftIds: async (ids) => [ids[0], ids[2]],
  });
  assert.deepEqual(result.summary, {
    total: 3, createCandidates: 1, existingConflicts: 0, draftConflicts: 2,
  });
  assert.equal(result.entries[0].outcome, 'draft-conflict');
  assert.equal(result.entries[2].outcome, 'draft-conflict');
});

test('D3b2 import rejects any unsupported legacy format, missing coverage or suspicious notes', () => {
  const normal = archive(2);
  const variants = [
    { ...normal, format: 'oge-backup' },
    { ...normal, version: 2 },
    { ...normal, scope: 'full-backup' },
    { ...normal, snapshot: 'invalid' },
    { ...normal, totalNotes: 999 },
    { ...normal, coverage: { ...normal.coverage, encryptedDrafts: 'included' } },
    { ...normal, notes: [...normal.notes, normal.notes[0]], totalNotes: 3 },
    { ...normal, notes: [{ ...normal.notes[0], id: '../secrets' }, normal.notes[1]] },
    { ...normal, notes: [{ ...normal.notes[0], heading: '   ' }, normal.notes[1]] },
    { ...normal, notes: [{ ...normal.notes[0], tags: ['UPPERCASE'] }, normal.notes[1]] },
    { ...normal, notes: [{ ...normal.notes[0], subjectId: randomUUID() + '/path' }, normal.notes[1]] },
    { ...normal, notes: [{ ...normal.notes[0], answer: 'changed', secret: 'payload' }, normal.notes[1]] },
    { ...normal, notes: [{ ...normal.notes[0], sha: 'spoofed' }, normal.notes[1]] },
  ];
  for (const invalid of variants)
    assert.throws(() => validateVaultNotesImportArchive(invalid),
      /vault-import-(archive|note)-invalid/);
});

test('D3b2 invalid size and unauthorized subject fail before remote Git tree reads', async () => {
  const input = archive(2);
  assert.throws(() => validateVaultNotesImportArchive(archive(12), { maxBytes: 1024 }),
    /vault-import-archive-invalid/);
  const f = githubFixture();
  await assert.rejects(plan(f.client, input, {
    subjectVerifier: async () => false,
  }), /vault-import-subject-unverified/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(planVaultNotesImport(f.client, input),
    TypeError);
});

test('D3b2 truncated tree, foreign note paths, duplicate paths or HEAD movement fail closed', async () => {
  const input = archive(1);
  for (const options of [
    { truncated: true },
    { changedHead: true },
    { customTree: [{ path: 'notes/../secret', type: 'blob', sha: sha('a') }] },
    { customTree: [{
      path: 'notes/' + input.notes[0].id + '.json', type: 'blob',
      sha: sha('a'), mode: '120000',
    }] },
    { customTree: Array(2).fill({
      path: 'notes/' + input.notes[0].id + '.json', type: 'blob', sha: sha('a'),
    }) },
  ]) {
    const f = githubFixture(options);
    await assert.rejects(plan(f.client, input),
      (error) => error instanceof VaultGitHubError && error.status === 409);
  }
});

test('D3b2 remote rate limits and malformed draft-checker results do not produce approval', async () => {
  const input = archive(1);
  const f = githubFixture({ errorAt: '/git/trees/' });
  await assert.rejects(plan(f.client, input),
    (error) => error instanceof VaultGitHubError && error.status === 429);
  await assert.rejects(plan(githubFixture().client, input, {
    pendingDraftIds: async () => ['not-an-uploaded-note'],
  }), /vault-import-draft-check-invalid/);
});

test('D3b2 large archive plan supports over 500 entries with bounded tree reads', async () => {
  const input = archive(501);
  const f = githubFixture();
  const result = await plan(f.client, input);
  assert.equal(result.summary.total, 501);
  assert.equal(result.summary.createCandidates, 501);
  assert.equal(f.calls.filter((request) => request.path.includes('/git/trees/')).length, 1);
});

test('D3b2 import endpoint is read-only, signed, default-off and protects private content', async () => {
  const route = await readFile(
    new URL('../app/api/vault/backup-import/plan/route.js', import.meta.url), 'utf8');
  const engine = await readFile(
    new URL('../lib/oge-vault-backup-import-plan.js', import.meta.url), 'utf8');
  assert.match(route, /OGE_VAULT_BACKUP_IMPORT_PLAN_PREVIEW !== 'true'/);
  assert.match(route, /OGE_VAULT_MAIN_PREVIEW !== 'true'/);
  assert.match(route, /const session = await auth\(\)/);
  assert.match(route, /getVaultNoteClient\(db/);
  assert.match(route, /ownerMutationFilter\(ownerId, \{ sessionVersion \}\)/);
  assert.match(route, /vault_drafts/);
  assert.match(route, /slug: \{ \$in: chunk \}/);
  assert.match(route, /readLimitedBody/);
  assert.match(route, /Cache-Control': 'private, no-store'/);
  assert.doesNotMatch(route, /export async function PUT|export async function DELETE/);
  assert.doesNotMatch(route, /\.insertOne\(|\.updateOne\(|\.deleteOne\(|commitVaultNoteBatch/);
  assert.doesNotMatch(engine, /\.collection\(|\.insertOne\(|\.updateOne\(|\.deleteOne\(|commitVaultNoteBatch/);
  assert.match(engine, /canCommit: false/);
});
