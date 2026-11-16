import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  withVaultOwnerDraftWrite, withVaultOwnerImportExclusive,
} from '../lib/oge-vault-import-fence.js';
import { VaultGitHubError } from '../lib/oge-vault-github.js';

const ownerId = 'synthetic-owner';
const repoId = 43;
const sessionVersion = randomUUID();
const owner = { ownerId, repoId, sessionVersion };

function database() {
  const user = {
    googleSub: ownerId, sessionVersion,
    vault: { status: 'connected', repoId },
    vaultActiveDraftWriters: 0,
  };
  const eligible = (filter) => {
    if (filter.$and && !filter.$and.every(eligible)) return false;
    if (filter.$or && !filter.$or.some(eligible)) return false;
    for (const [name, rule] of Object.entries(filter)) {
      if (name === '$and' || name === '$or') continue;
      const actual = name.split('.').reduce((v, field) => v?.[field], user);
      if (rule && typeof rule === 'object' && !(rule instanceof Date)) {
        if (Object.hasOwn(rule, '$exists') && (actual !== undefined) !== rule.$exists)
          return false;
        if (Object.hasOwn(rule, '$gt') && !(actual > rule.$gt)) return false;
        if (Object.hasOwn(rule, '$ne') && actual === rule.$ne) return false;
      } else if (actual !== rule) return false;
    }
    return true;
  };
  const db = { collection(name) {
    assert.equal(name, 'users');
    return { async updateOne(filter, update) {
      if (!eligible(filter)) return { matchedCount: 0 };
      for (const [name, delta] of Object.entries(update.$inc || {}))
        user[name] = (user[name] || 0) + delta;
      for (const [name, value] of Object.entries(update.$set || {})) {
        const steps = name.split('.'), last = steps.pop();
        let obj = user;
        for (const field of steps) obj = obj[field] ||= {};
        obj[last] = value;
      }
      for (const name of Object.keys(update.$unset || {})) {
        const steps = name.split('.'), last = steps.pop();
        let obj = user;
        for (const field of steps) obj = obj?.[field];
        if (obj) delete obj[last];
      }
      return { matchedCount: 1 };
    } };
  } };
  return { db, user };
}

test('D3b2b2a import cannot start while any encrypted draft writer is active', async () => {
  const { db, user } = database();
  let done;
  const writing = withVaultOwnerDraftWrite(db, owner, () =>
    new Promise((resolve) => { done = resolve; }));
  assert.equal(user.vaultActiveDraftWriters, 1);
  await assert.rejects(withVaultOwnerImportExclusive(db, owner, async () => {}),
    (error) => error instanceof VaultGitHubError && error.status === 409);
  done('autosaved');
  assert.equal(await writing, 'autosaved');
  assert.equal(user.vaultActiveDraftWriters, 0);
  assert.equal(await withVaultOwnerImportExclusive(db, owner, async () => 'imported'),
    'imported');
});

test('D3b2b2a active import blocks cross-subject draft writes without deleting drafts', async () => {
  const { db, user } = database();
  let finish;
  const importing = withVaultOwnerImportExclusive(db, owner, () =>
    new Promise((resolve) => { finish = resolve; }));
  assert.equal(typeof user.vaultImportLock.operationId, 'string');
  await assert.rejects(withVaultOwnerDraftWrite(db, owner, async () => {
    throw new Error('draft must never run');
  }), (error) => error.message === 'vault-import-draft-write-blocked');
  await assert.rejects(withVaultOwnerImportExclusive(db, owner, async () => {}),
    (error) => error.status === 409);
  finish('confirmed');
  assert.equal(await importing, 'confirmed');
  assert.equal(user.vaultImportLock, undefined);
  assert.equal(await withVaultOwnerDraftWrite(db, owner, async () => 'drafted'),
    'drafted');
});

test('D3b2b2a GitHub failure releases import fence, not the encrypted draft', async () => {
  const { db, user } = database();
  await assert.rejects(withVaultOwnerImportExclusive(db, owner, async () => {
    throw new Error('github-no-ack');
  }), /github-no-ack/);
  assert.equal(user.vaultImportLock, undefined);
  assert.equal(user.vaultActiveDraftWriters, 0);
});

test('D3b2b2a failed release never claims an import or autosave succeeded', async () => {
  const { db, user } = database();
  await assert.rejects(withVaultOwnerImportExclusive(db, owner, async () => {
    user.vaultImportLock.operationId = randomUUID(); // simulate lost lock ownership
  }), /vault-import-exclusive-fence-release-unconfirmed/);
  assert.ok(user.vaultImportLock, 'uncertain import fence remains fail closed');
  await assert.rejects(withVaultOwnerDraftWrite(db, owner, async () => {}),
    (error) => error.status === 409);

  const f = database();
  await assert.rejects(withVaultOwnerDraftWrite(f.db, owner, async () => {
    f.user.vaultActiveDraftWriters = 0; // simulate unsafe external counter edit
  }), /vault-import-draft-fence-release-unconfirmed/);
});

test('D3b2b2a rejects stale session incarnation and different connected repository', async () => {
  const { db, user } = database();
  const old = { ...owner, sessionVersion: randomUUID() };
  await assert.rejects(withVaultOwnerImportExclusive(db, old, async () => {}),
    (error) => error.status === 409);
  await assert.rejects(withVaultOwnerDraftWrite(db, old, async () => {}),
    (error) => error.status === 409);
  user.vault.repoId += 1;
  await assert.rejects(withVaultOwnerImportExclusive(db, owner, async () => {}),
    (error) => error.status === 409);
});

test('D3b2b2a legacy sessionVersion=0 retains its epoch predicate', async () => {
  const { db, user } = database();
  user.sessionVersion = randomUUID();
  await assert.rejects(withVaultOwnerImportExclusive(db,
    { ...owner, sessionVersion: 0 }, async () => {}),
  (error) => error.status === 409);
  user.sessionVersion = 0;
  assert.equal(await withVaultOwnerImportExclusive(db,
    { ...owner, sessionVersion: 0 }, async () => 'old-session'), 'old-session');
});

test('D3b2b2a draft and approved import routes use owner import fencing', async () => {
  const drafts = await readFile(new URL('../app/api/vault/drafts/route.js', import.meta.url), 'utf8');
  const commit = await readFile(new URL(
    '../app/api/vault/backup-import/commit/route.js', import.meta.url), 'utf8');
  assert.match(drafts, /withVaultOwnerDraftWrite\(ctx\.db/);
  assert.match(commit, /withVaultOwnerImportExclusive\(db/);
  assert.match(commit, /withVaultSubjectsWrite\(db, ownerId, subjectIds/);
  assert.doesNotMatch(drafts, /\.collection\(['"]notes['"]\)/);
});

test('D3b2b2c3 preserves durable quarantine for a failed GitHub write of unknown outcome', async () => {
  const f = database();
  const marker = 'Restore OgeNotes backup ' + 'a'.repeat(64);
  let initiated = false;
  await assert.rejects(withVaultOwnerImportExclusive(f.db, owner,
    async ({ markGitHubWriteAttempt }) => {
      await markGitHubWriteAttempt(marker);
      initiated = true;
      throw new Error('lost GitHub acknowledgment even if GitHub persisted');
    }), (err) => err.message === 'vault-import-write-outcome-unconfirmed-lock-retained' &&
      err.status === 503);
  assert.equal(initiated, true);
  assert.equal(f.user.vaultImportLock.state, 'github-write-possible');
  assert.equal(f.user.vaultImportLock.commitMarker, marker);
  assert.ok(f.user.vaultImportLock.attemptedAt instanceof Date);
  await assert.rejects(withVaultOwnerDraftWrite(f.db, owner, async () => {}),
    (err) => err.status === 409);
  await assert.rejects(withVaultOwnerImportExclusive(f.db, owner, async () => {}),
    (err) => err.status === 409);
});

test('D3b2b2c3 verified GitHub success releases lock after durable write marker', async () => {
  const f = database();
  const value = await withVaultOwnerImportExclusive(f.db, owner,
    async ({ markGitHubWriteAttempt }) => {
      await markGitHubWriteAttempt('Restore OgeNotes backup ' + 'b'.repeat(64));
      return 'verified-commit';
    });
  assert.equal(value, 'verified-commit');
  assert.equal(f.user.vaultImportLock, undefined);
  assert.equal(f.user.vaultActiveDraftWriters, 0);
});

test('D3b2b2c3 marker refusal happens before any GitHub write', async () => {
  for (const malformed of ['', 'bad-digest', 'Restore OgeNotes backup ' + 'f'.repeat(63)]) {
    const f = database();
    let writes = 0;
    await assert.rejects(withVaultOwnerImportExclusive(f.db, owner,
      async ({ markGitHubWriteAttempt }) => {
        await markGitHubWriteAttempt(malformed);
        writes++;
      }), TypeError);
    assert.equal(writes, 0);
    assert.equal(f.user.vaultImportLock, undefined);
  }
});

test('D3b2b2c3 repeated markers cannot turn a second import into a write', async () => {
  const f = database();
  const marker = 'Restore OgeNotes backup ' + 'c'.repeat(64);
  await assert.rejects(withVaultOwnerImportExclusive(f.db, owner,
    async ({ markGitHubWriteAttempt }) => {
      await markGitHubWriteAttempt(marker);
      await markGitHubWriteAttempt(marker);
    }), (err) => err.status === 503);
  assert.equal(f.user.vaultImportLock.state, 'github-write-possible');
});

test('D3b2b2c3 GitHub adapter invokes owner write marker before the batch writer', async () => {
  const route = await readFile(new URL(
    '../app/api/vault/backup-import/commit/route.js', import.meta.url), 'utf8');
  const adapter = await readFile(new URL(
    '../lib/oge-vault-backup-import-commit.js', import.meta.url), 'utf8');
  assert.match(route, /beforeGitHubWrite: markGitHubWriteAttempt/);
  assert.match(adapter, /if \(beforeGitHubWrite\) await beforeGitHubWrite\(commitMessage\)/);
  assert.ok(adapter.indexOf('await beforeGitHubWrite(commitMessage)') <
    adapter.indexOf('await batchWriter(client, operations'));
});
