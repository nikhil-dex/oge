import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { inspectVaultSubject } from '../lib/oge-vault-subject-preflight.js';

const subjectId = randomUUID();
const scope = { ownerId: 'owner-a', repoId: 100, subjectId };
const snap = 'a'.repeat(40);
const note = (subject) => ({ id: randomUUID(), subjectId: subject });
const drafts = (pending = false) => ({
  async countDocuments(filter, options) {
    assert.deepEqual(filter, { ownerId: scope.ownerId, repoId: scope.repoId });
    assert.equal(options.limit, 1);
    return pending ? 1 : 0;
  },
});

test('preflight refuses deletion when any owner/repository drafts are pending', async () => {
  let githubCalled = false;
  const result = await inspectVaultSubject({}, drafts(true), scope, {
    pageReader: async () => { githubCalled = true; throw Error('unexpected'); },
  });
  assert.equal(githubCalled, false);
  assert.equal(result.safeToDelete, false);
  assert.equal(result.reason, 'pending-vault-drafts');
});

test('preflight scans all pages, not only first 25 notes', async () => {
  let calls = 0;
  const result = await inspectVaultSubject({}, drafts(), scope, {
    pageReader: async (_client, { cursor, limit }) => {
      assert.equal(limit, 25);
      calls += 1;
      return cursor ? {
        snapshot: snap, total: 26, notes: [note(subjectId)], nextCursor: null,
      } : {
        snapshot: snap, total: 26, notes: Array.from({ length: 25 }, () => note(randomUUID())),
        nextCursor: 'second',
      };
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.safeToDelete, false);
  assert.equal(result.reason, 'github-notes-exist');
});

test('preflight provides advisory empty result only after full scan', async () => {
  let checks = 0;
  const result = await inspectVaultSubject({}, {
    async countDocuments() { checks += 1; return 0; },
  }, scope, { pageReader: async () => ({
    snapshot: snap, total: 1, notes: [note(randomUUID())], nextCursor: null,
  }) });
  assert.equal(checks, 2);
  assert.deepEqual(result, {
    safeToDelete: true, reason: 'empty-at-snapshot', pendingDrafts: false,
    githubNotes: false, scannedNotes: 1, snapshot: snap,
  });
});

test('preflight fails closed on stale snapshots and cursor loops', async () => {
  await assert.rejects(inspectVaultSubject({}, drafts(), scope, {
    pageReader: async (_c, { cursor }) => ({
      snapshot: cursor ? 'b'.repeat(40) : snap, total: 1,
      notes: cursor ? [note(randomUUID())] : [note(randomUUID())], nextCursor: cursor ? null : 'second',
    }),
  }), /vault-subject-scan-invalid/);
  await assert.rejects(inspectVaultSubject({}, drafts(), scope, {
    pageReader: async () => ({ snapshot: snap, total: 2, notes: [note(randomUUID())], nextCursor: 'repeat' }),
  }), /vault-subject-scan-invalid/);
});

test('subject preflight remains non-destructive and legacy connected-vault delete guard remains', async () => {
  const route = await readFile(new URL('../app/api/vault/subjects/preflight/route.js', import.meta.url), 'utf8');
  const legacy = await readFile(new URL('../app/api/subjects/route.js', import.meta.url), 'utf8');
  assert.match(route, /export async function GET/);
  assert.doesNotMatch(route, /export async function DELETE/);
  const journal = await readFile(new URL('../lib/oge-vault-subject-journal.js', import.meta.url), 'utf8');
  assert.match(route, /journalVaultSubjectInspection/);
  assert.match(journal, /advisoryOnly: true/);
  assert.match(route, /OGE_VAULT_MAIN_PREVIEW/);
  assert.match(route, /OGE_VAULT_HYBRID_DRAFT_PREVIEW/);
  assert.match(route, /session\.user\.sessionVersion/);
  assert.match(legacy, /Subject deletion is temporarily disabled for connected Oge Vault accounts/);
});

test('preflight rejects silently truncated GitHub pagination', async () => {
  await assert.rejects(inspectVaultSubject({}, drafts(), scope, {
    pageReader: async () => ({
      snapshot: snap, total: 2, notes: [note(randomUUID())], nextCursor: null,
    }),
  }), /vault-subject-scan-invalid/);
});
