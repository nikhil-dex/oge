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
      for (const [name, value] of Object.entries(update.$set || {}))
        user[name] = value;
      for (const name of Object.keys(update.$unset || {}))
        delete user[name];
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
