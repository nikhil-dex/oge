import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash, webcrypto } from 'node:crypto';
import {
  chmod, mkdtemp, writeFile, readdir, rm, symlink, readFile,
} from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatedNote } from '../lib/oge-vault-notes.js';
import { vaultNotesInventorySha256 } from '../lib/oge-vault-backup-export-chunk.js';
import { createVaultOfflineEncryptSession } from '../lib/oge-vault-offline-backup-crypto.js';
import { prepareVaultOperatorEncryptedRestore } from '../lib/oge-vault-operator-encrypted-chunks.js';

const hash = (alg, input) => createHash(alg).update(input).digest('hex');
const sha1 = (s) => hash('sha1', s);
const sha256 = (s) => hash('sha256', s);
const passphrase = 'Unique private operator backup passphrase 2026!';
const subjectId = randomUUID();
const id = (n) => n.toString(16).padStart(8, '0') +
  '-0000-4000-8000-' + n.toString(16).padStart(12, '0');
const noteKeys = [
  'format','version','id','subjectId','heading','answer',
  'tags','favorite','updatedAt','createdAt','sha',
];
function fixtures(count = 65) {
  const source = sha1('M66-SOURCE'), target = sha1('M66-TARGET');
  const notes = Array.from({ length: count }, (_, i) => ({
    ...validatedNote({
      subjectId, heading: 'Secret ' + i, answer: 'Do not log this ' + i,
      tags: [], favorite: false,
    }, { id: id(i + 1), now: '2026-11-16T17:00:00.000Z' }),
    sha: sha1('M66-BLOB-' + i),
  }));
  const inventory = vaultNotesInventorySha256(
    notes.map((n) => ({ id: n.id, sha: n.sha })));
  const pages = [];
  for (let offset = 0; offset < count || offset === 0; offset += 64) {
    const part = notes.slice(offset, offset + 64);
    const hasMore = offset + part.length < count;
    pages.push({
      format: 'oge-vault-notes-backup-chunk', version: 1,
      scope: 'current-github-notes-only', snapshot: source,
      totalNotes: count, inventorySha256: inventory,
      offset, count: part.length,
      afterId: offset ? notes[offset - 1].id : null,
      nextAfterId: hasMore ? part.at(-1).id : null,
      hasMore,
      coverage: {
        notes: 'partial-immutable-snapshot-chunk',
        historicalRevisions: 'not-included',
        quickNotes: 'not-included', airNotes: 'not-included',
        encryptedDrafts: 'not-included', learningProgress: 'not-included',
      },
      notes: part, chunkSha256: sha256(JSON.stringify(part)),
      completeBackup: false, importableAsLegacyBackup: false,
    });
  }
  const selected = [notes[0], notes.at(-1)].filter(
    (n, i, a) => a.findIndex((x) => x.id === n.id) === i);
  const approval = {
    confirmation: 'COMMIT_VERIFIED_CHUNK_BATCH_CREATE_ONLY',
    expectedSourceSnapshot: source,
    expectedSourceInventorySha256: inventory,
    expectedTargetHead: target,
    selectedIds: selected.map((n) => n.id),
    expectedSelectionFingerprint: sha256(JSON.stringify({
      sourceSnapshot: source, sourceInventorySha256: inventory,
      targetHead: target,
      selected: selected.map((n) => ({
        id: n.id, sha: n.sha,
        contentDigest: sha256(JSON.stringify(noteKeys.map((key) => n[key]))),
        subjectId: n.subjectId,
      })),
    })),
  };
  return { pages, approval };
}
async function secureEncryptedParts(folder, pages) {
  const session = await createVaultOfflineEncryptSession(passphrase, {
    webCrypto: webcrypto,
  });
  try {
    for (let i = 0; i < pages.length; i++) {
      const encrypted = await session.seal(JSON.stringify(pages[i]), i + 1);
      await writeFile(join(folder, encrypted.filename), encrypted.text, {
        mode: 0o600,
      });
    }
  } finally { session.close(); }
}
async function withDirectory(fn) {
  const folder = await mkdtemp(join(tmpdir(), 'oge-m66-cipher-'));
  try {
    await chmod(folder, 0o700);
    return await fn(folder);
  } finally { await rm(folder, { recursive: true, force: true }); }
}

test('M66 decrypts encrypted private parts entirely in memory with exact reviewed selection', async () =>
  withDirectory(async (folder) => {
    const { pages, approval } = fixtures();
    await secureEncryptedParts(folder, pages);
    const before = await readdir(folder);
    const result = await prepareVaultOperatorEncryptedRestore(folder,
      passphrase, approval);
    assert.equal(result.preflightComplete, true);
    assert.equal(result.encryptedParts, 2);
    assert.equal(result.signedGitHubSourceAuthenticated, false);
    const chunks = [];
    for await (const chunk of result.chunks()) chunks.push(chunk);
    assert.deepEqual(chunks, pages);
    assert.deepEqual(await readdir(folder), before);
    assert.ok(before.every((name) => name.endsWith('.oge.json')));
  }));

test('M66 denies bad password, changed reviewed target and tampered GCM AAD', async () =>
  withDirectory(async (folder) => {
    const { pages, approval } = fixtures(1);
    await secureEncryptedParts(folder, pages);
    await assert.rejects(
      prepareVaultOperatorEncryptedRestore(folder,
        'A completely different password 2026!', approval), TypeError);
    await assert.rejects(
      prepareVaultOperatorEncryptedRestore(folder, passphrase, {
        ...approval, expectedTargetHead: sha1('WRONG-TARGET'),
      }), TypeError);
    const name = 'part-0001.oge.json';
    const changed = JSON.parse(await readFile(join(folder, name), 'utf8'));
    changed.iv = 'a'.repeat(24);
    await writeFile(join(folder, name), JSON.stringify(changed));
    await assert.rejects(
      prepareVaultOperatorEncryptedRestore(folder, passphrase, approval),
      TypeError);
  }));

test('M66 denies gap, mixed plaintext, insecure 0644, and symlinked files', async () =>
  withDirectory(async (folder) => {
    const { pages, approval } = fixtures();
    await secureEncryptedParts(folder, pages);
    const second = join(folder, 'part-0002.oge.json');
    await rm(second);
    await assert.rejects(
      prepareVaultOperatorEncryptedRestore(folder, passphrase, approval),
      TypeError);
    await writeFile(second, '{}', { mode: 0o600 });
    await assert.rejects(
      prepareVaultOperatorEncryptedRestore(folder, passphrase, approval),
      TypeError);
    await rm(second);
    await writeFile(join(folder, 'part-0001.json'), '{}', { mode: 0o600 });
    await assert.rejects(
      prepareVaultOperatorEncryptedRestore(folder, passphrase, approval),
      TypeError);
    await rm(join(folder, 'part-0001.json'));
    await secureEncryptedParts(folder, pages);
    await chmod(second, 0o644);
    await assert.rejects(
      prepareVaultOperatorEncryptedRestore(folder, passphrase, approval),
      TypeError);
    await chmod(second, 0o600);
    const first = join(folder, 'part-0001.oge.json');
    const target = join(folder, 'source.oge.json');
    await writeFile(target, await readFile(first), { mode: 0o600 });
    await rm(first);
    await symlink(target, first);
    await assert.rejects(
      prepareVaultOperatorEncryptedRestore(folder, passphrase, approval),
      TypeError);
  }));

test('M66 reads passphrase only from FD3 private pipe with strict EOF and bounds', async () => {
  const helperUrl = new URL('../lib/oge-vault-operator-encrypted-chunks.js',
    import.meta.url).href;
  const program = 'import { readVaultOperatorBackupPassphraseFd3 as read } from ' +
    JSON.stringify(helperUrl) +
    ';try{const p=await read();console.log(p.length)}catch{process.exitCode=1}';
  const run = async (input) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', program],
      { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (x) => { out += x; });
    child.stderr.on('data', (x) => { err += x; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
    child.stdio[3].end(input);
  });
  const valid = await run(passphrase);
  assert.equal(valid.code, 0);
  assert.equal(valid.out.trim(), String(passphrase.length));
  assert.equal(valid.err, '');
  for (const input of ['short', passphrase + '\n',
    passphrase + 'x'.repeat(1025)]) {
    const denied = await run(input);
    assert.equal(denied.code, 1);
    assert.equal(denied.out, '');
    assert.equal(denied.err, '');
  }
});

test('M66 encrypted preflight precedes MongoDB and one-time signed ticket claim', async () => {
  const script = await readFile(new URL(
    '../scripts/commit-vault-chunk-restore-staging.mjs', import.meta.url),
    'utf8');
  const helper = await readFile(new URL(
    '../lib/oge-vault-operator-encrypted-chunks.js', import.meta.url), 'utf8');
  assert.match(script, /OGE_VAULT_CHUNK_RESTORE_ENCRYPTED_OPERATOR/);
  assert.match(script, /readVaultOperatorBackupPassphraseFd3/);
  assert.match(script, /prepareVaultOperatorEncryptedRestore/);
  assert.match(script, /verifyVaultRestoreApprovalTicket/);
  assert.match(script, /claimVaultRestoreApprovalOnce/);
  assert.match(script, /executeApprovedVaultChunkRestoreBatch/);
  assert.ok(script.indexOf('prepareVaultOperatorEncryptedRestore(') <
    script.indexOf('await mongo.connect()'));
  assert.ok(script.indexOf('prepareVaultOperatorEncryptedRestore(') <
    script.indexOf('await claimVaultRestoreApprovalOnce('));
  assert.doesNotMatch(helper,
    /writeFile|mkdtemp|createWriteStream|MongoClient|fetch\(|localStorage/);
});
