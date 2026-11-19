import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { validatedNote } from '../lib/oge-vault-notes.js';
import { validatedStandaloneCapture } from '../lib/oge-vault-standalone-captures.js';
import {
  exportVaultCurrentResourcesSnapshot,
} from '../lib/oge-vault-backup-current-resources.js';
import {
  vaultCurrentResourceSourceCheckAllowed,
  buildVaultCurrentResourceSourceClaim,
  assertVaultCurrentResourceSourceClaim,
  compareVaultCurrentResourceSourceClaim,
} from '../lib/oge-vault-current-resource-source-verify.js';
import {
  inspectVaultCurrentResourceFileAndSource,
} from '../lib/oge-vault-current-resource-source-check-browser.js';

const hash = v => createHash('sha1').update(v).digest('hex');
const HEAD = hash('m89-current'), TREE = hash('m89-tree');
const SUBJECT = randomUUID(), NOW = '2026-11-17T00:00:00.000Z';
const ORIGIN = 'https://vault-staging.example.test';
const env = {
  OGE_VAULT_CURRENT_RESOURCE_SOURCE_CHECK_PREVIEW: 'true',
  OGE_VAULT_RECOVERY_CENTER_PREVIEW: 'true',
  OGE_VAULT_CURRENT_RESOURCE_BACKUP_PREVIEW: 'true',
  OGE_VAULT_BACKUP_EXPORT_PREVIEW: 'true',
  OGE_VAULT_STANDALONE_PREVIEW: 'true',
  OGE_VAULT_MAIN_PREVIEW: 'true',
  OGE_VAULT_NOTE_API_PREVIEW: 'true',
  OGE_VAULT_HYBRID_DRAFT_PREVIEW: 'true',
  OGE_VAULT_STANDALONE_RESTORE_COMMIT_PREVIEW: 'false',
  OGE_VAULT_BACKUP_IMPORT_COMMIT_PREVIEW: 'false',
  OGE_VAULT_CUTOVER_GUARD_PREVIEW: 'false',
  OGE_ACCOUNT_DELETION_ENABLED: 'false',
  OGE_VAULT_ACCOUNT_DELETION_INTERNAL: 'false',
  OGE_VAULT_DESTRUCTIVE_DELETE_INTERNAL: 'false',
  OGE_VAULT_SUBJECT_RETIRE_INTERNAL: 'false',
  OGE_STAGING_URL: ORIGIN,
  AUTH_URL: ORIGIN,
  OGE_VAULT_BASE_URL: ORIGIN,
  MONGODB_DB: 'oge_vault_restore_staging_m89',
};
const ready = () => ({ ok: true });
function syntheticRepo({ changedHead = false, noteBody = 'sensitive research notes' } = {}) {
  const rows = [
    { kind: 'notes', id: randomUUID(), key: 'notes/' },
    { kind: 'quickNotes', id: randomUUID(), key: 'quick-notes/' },
    { kind: 'airNotes', id: randomUUID(), key: 'airnotes/' },
  ];
  const note = validatedNote({
    subjectId: SUBJECT, heading: 'Private GitHub research',
    answer: noteBody, tags: ['study'], favorite: false,
  }, { id: rows[0].id, now: NOW });
  const quick = validatedStandaloneCapture('quick-notes', {
    content: 'Private Quick Note\nresearch idea',
  }, { id: rows[1].id, now: NOW });
  const air = validatedStandaloneCapture('airnotes', {
    content: 'Private AirNote research',
  }, { id: rows[2].id, now: NOW });
  const data = [note, quick, air];
  const blobs = new Map();
  const tree = rows.map((row, i) => {
    const sha = hash('m89-provider-private-blob-' + i);
    blobs.set(sha, data[i]);
    return {
      path: row.key + row.id + '.json',
      sha, type: 'blob', mode: '100644',
      size: Buffer.byteLength(JSON.stringify(data[i])),
    };
  });
  let reads = 0;
  const calls = [];
  const client = {
    readOnly: true, branch: 'main',
    async call(path, options = {}) {
      assert.equal(options.method || 'GET', 'GET');
      calls.push(path);
      if (path === '/git/ref/heads/main') {
        reads++;
        return { object: { sha: changedHead && reads > 1
          ? hash('m89-moved-head') : HEAD } };
      }
      if (path === '/git/commits/' + HEAD) return { tree: { sha: TREE } };
      if (path === '/git/trees/' + TREE + '?recursive=1')
        return { truncated: false, tree };
      if (path.startsWith('/git/blobs/')) {
        const sha = path.slice('/git/blobs/'.length);
        const blob = blobs.get(sha);
        if (!blob) throw new TypeError('Invalid synthetic blob');
        return {
          sha, encoding: 'base64',
          content: Buffer.from(JSON.stringify(blob)).toString('base64'),
          size: Buffer.byteLength(JSON.stringify(blob)),
        };
      }
      throw new TypeError('Unexpected synthetic provider access');
    },
  };
  return {
    client, calls, get reads() { return reads; },
    subjectVerifier: async ids => ids.every(id => id === SUBJECT),
  };
}
async function source(f) {
  return exportVaultCurrentResourcesSnapshot(f.client, {
    subjectVerifier: f.subjectVerifier,
  });
}
function fakeFile(value) {
  const bytes = new TextEncoder().encode(value);
  return {
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.slice().buffer,
  };
}

test('M89 real M73 synthetic GitHub exporter source matches exact authenticated current archive SHA256 without disclosing content', async () => {
  const fixture = syntheticRepo();
  const archive = await source(fixture);
  const claim = buildVaultCurrentResourceSourceClaim(archive);
  const report = compareVaultCurrentResourceSourceClaim(claim, archive);
  assert.equal(report.status,
    'CURRENT_PRIVATE_GITHUB_SOURCE_FINGERPRINT_MATCHES_READ_ONLY');
  assert.equal(report.currentGitHubSnapshotContentMatchedAtCheck, true);
  assert.equal(report.authenticatedOwnerGitHubReadPerformedByServer, true);
  assert.equal(report.fileContentsUploaded, false);
  assert.equal(report.privateNoteBodiesReturned, false);
  assert.equal(report.canRestore, false);
  assert.equal(report.canReleaseImportLock, false);
  assert.equal(fixture.reads, 2);
  assert.equal(fixture.calls.filter(p => p.startsWith('/git/blobs/')).length, 3);
  const serialized = JSON.stringify(report);
  for (const secret of [
    'sensitive research', archive.notes[0].heading, archive.notes[0].id,
    archive.archiveSha256, archive.inventorySha256,
    archive.snapshot, archive.treeSha,
  ]) assert.equal(serialized.includes(secret), false);
});

test('M89 an older/modified locally self-consistent backup does NOT match current provider HEAD; mismatch is not corruption', async () => {
  const a = await source(syntheticRepo({ noteBody: 'first version' }));
  const original = buildVaultCurrentResourceSourceClaim(a);
  const altered = await source(syntheticRepo({ noteBody: 'different current content' }));
  const report = compareVaultCurrentResourceSourceClaim(original, altered);
  assert.equal(report.currentGitHubSnapshotContentMatchedAtCheck, false);
  assert.equal(report.status,
    'CURRENT_PRIVATE_GITHUB_SOURCE_FINGERPRINT_DIFFERS_HOLD');
  assert.equal(report.olderSnapshotsCanDifferWithoutBeingCorrupt, true);
  assert.equal(report.canAuthorizeImport, false);
  for (const changed of [
    { snapshot: hash('old historical head') },
    { treeSha: hash('different tree') },
    { archiveSha256: '1'.repeat(64) },
    { inventorySha256: '1'.repeat(64) },
    { totalNotes: 900 },
    { totalQuickNotes: 30 },
    { totalAirNotes: 30 },
  ]) {
    const mismatch = compareVaultCurrentResourceSourceClaim({
      ...buildVaultCurrentResourceSourceClaim(altered), ...changed,
    }, altered);
    assert.equal(mismatch.currentGitHubSnapshotContentMatchedAtCheck, false);
  }
});

test('M89 invalid claims fail BEFORE private GitHub or Mongo operations; flags cannot grant restores', async () => {
  const archive = await source(syntheticRepo());
  const clean = buildVaultCurrentResourceSourceClaim(archive);
  for (const change of [
    { confirmation: 'RESTORE' },
    { format: 'untrusted-other' },
    { snapshot: 'bad' },
    { treeSha: 'not-a-sha' },
    { archiveSha256: 'invalid' },
    { inventorySha256: 'invalid' },
    { totalNotes: -1 },
    { totalNotes: 30001 },
    { totalQuickNotes: 301 },
    { totalAirNotes: 301 },
    { version: 2 },
    { privateNoteBody: 'please upload private notes' },
    { canReleaseImportLock: true },
  ]) assert.throws(() => assertVaultCurrentResourceSourceClaim({
    ...clean, ...change,
  }), TypeError);
  assert.throws(() => assertVaultCurrentResourceSourceClaim(
    null), TypeError);
});

test('M89 source comparison independently DEFAULT OFF, rejects wrong staging/origin/write flags', () => {
  assert.equal(vaultCurrentResourceSourceCheckAllowed({}, ready), false);
  assert.equal(vaultCurrentResourceSourceCheckAllowed(env, ready), true);
  assert.equal(vaultCurrentResourceSourceCheckAllowed(env,
    () => ({ ok: false })), false);
  for (const change of [
    { OGE_VAULT_CURRENT_RESOURCE_SOURCE_CHECK_PREVIEW: 'false' },
    { OGE_VAULT_RECOVERY_CENTER_PREVIEW: 'false' },
    { OGE_VAULT_CURRENT_RESOURCE_BACKUP_PREVIEW: 'false' },
    { OGE_VAULT_BACKUP_EXPORT_PREVIEW: 'false' },
    { OGE_VAULT_STANDALONE_PREVIEW: 'false' },
    { MONGODB_DB: 'oge_prod' },
    { OGE_STAGING_URL: 'https://production.example.com' },
    { AUTH_URL: 'https://other-staging.example.test' },
    { OGE_VAULT_BASE_URL: 'https://other-staging.example.test' },
    { OGE_VAULT_STANDALONE_RESTORE_COMMIT_PREVIEW: 'true' },
    { OGE_VAULT_STANDALONE_RESTORE_WRITE_ACK: 'YES' },
    { OGE_VAULT_BACKUP_IMPORT_COMMIT_PREVIEW: 'true' },
    { OGE_VAULT_DESTRUCTIVE_DELETE_INTERNAL: 'true' },
  ]) assert.equal(vaultCurrentResourceSourceCheckAllowed({
    ...env, ...change,
  }, ready), false, JSON.stringify(change));
});

test('M89 full browser flow validates local file FIRST, sends only fingerprint + counts, and reads no arbitrary URL', async () => {
  const repo = syntheticRepo();
  const archive = await source(repo);
  const file = fakeFile(JSON.stringify(archive));
  let requests = 0;
  const verify = async (url, options) => {
    requests++;
    assert.equal(url, '/api/vault/backup-current-resources/source-check');
    assert.equal(options.method, 'POST');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.cache, 'no-store');
    const claim = JSON.parse(options.body);
    assertVaultCurrentResourceSourceClaim(claim);
    assert.equal(claim.archiveSha256, archive.archiveSha256);
    assert.equal(claim.snapshot, archive.snapshot);
    assert.equal(options.body.includes(archive.notes[0].answer), false);
    assert.equal(options.body.includes(archive.notes[0].id), false);
    return Response.json(compareVaultCurrentResourceSourceClaim(claim, archive));
  };
  const result = await inspectVaultCurrentResourceFileAndSource(file, {
    subtle: webcrypto.subtle, fetcher: verify,
  });
  assert.equal(requests, 1);
  assert.equal(result.local.totalNotes, 1);
  assert.equal(result.source.matched, true);
  assert.equal(result.source.archiveFileUploaded, false);
  assert.equal(result.source.restorationAuthorized, false);
  assert.equal(result.source.canReleaseImportLock, false);
  for (const mutate of [
    a => { a.notes[0].answer = 'modified with unchanged SHA256'; },
    a => { a.archiveSha256 = 'f'.repeat(64); },
    a => { a.totalNotes = 500; },
  ]) {
    requests = 0;
    const altered = JSON.parse(JSON.stringify(archive));
    mutate(altered);
    await assert.rejects(inspectVaultCurrentResourceFileAndSource(
      fakeFile(JSON.stringify(altered)),
      { subtle: webcrypto.subtle, fetcher: verify },
    ), TypeError);
    assert.equal(requests, 0, 'Never call GitHub server if local bytes fail SHA256');
  }
});

test('M89 provider read/head drift or malformed browser response cannot be treated as source authentication', async () => {
  await assert.rejects(source(syntheticRepo({ changedHead: true })));
  const archive = await source(syntheticRepo());
  const file = fakeFile(JSON.stringify(archive));
  const failResponse = async () => Response.json({
    status: 'CURRENT_PRIVATE_GITHUB_SOURCE_FINGERPRINT_MATCHES_READ_ONLY',
    currentGitHubSnapshotContentMatchedAtCheck: true,
    canRestore: true,
  });
  for (const fetcher of [
    async () => new Response('oauth redirect', { status: 302 }),
    async () => Response.json({ error: 'too many requests' }, { status: 429 }),
    failResponse,
    async () => Response.json({
      ...compareVaultCurrentResourceSourceClaim(
        buildVaultCurrentResourceSourceClaim(archive), archive),
      canReleaseImportLock: true,
    }),
  ]) {
    await assert.rejects(inspectVaultCurrentResourceFileAndSource(file, {
      subtle: webcrypto.subtle, fetcher,
    }), TypeError);
  }
});

test('M89 server route keeps all Note plaintext on private GitHub path, rechecks signed session+owner and returns booleans only', async () => {
  const [route, ui, browser] = await Promise.all([
    readFile(new URL('../app/api/vault/backup-current-resources/source-check/route.js',
      import.meta.url), 'utf8'),
    readFile(new URL('../app/vault/recovery/vault-current-source-check.js',
      import.meta.url), 'utf8'),
    readFile(new URL('../lib/oge-vault-current-resource-source-check-browser.js',
      import.meta.url), 'utf8'),
  ]);
  assert.match(route, /vaultCurrentResourceSourceCheckAllowed\(process\.env\)/);
  assert.match(route, /request\.headers\.get\('origin'\)/);
  assert.match(route, /readLimitedBody\(request, 512\)/);
  assert.match(route, /assertVaultCurrentResourceSourceClaim/);
  assert.match(route, /await auth\(\)/);
  assert.match(route, /readOnly: true/);
  assert.match(route, /exportVaultCurrentResourcesSnapshot/);
  assert.match(route, /subjectVerifier: async/);
  assert.match(route, /ownerMutationFilter\(ownerId, \{ sessionVersion \}\)/);
  assert.match(route, /limit: 3, windowMs: 60 \* 60 \* 1000/);
  assert.match(route, /compareVaultCurrentResourceSourceClaim\(claim, source\)/);
  assert.match(route, /Cache-Control': 'private, no-store'/);
  assert.doesNotMatch(route,
    /\b(?:deleteOne|updateOne|insertOne|markGitHubWriteAttempt|releasePreWriteVaultImportLock)\(/);
  assert.match(browser, /inspectVaultCurrentResourceFileLocally/);
  assert.match(browser, /onVerifiedFingerprint/);
  assert.match(browser, /body: JSON\.stringify\(claim\)/);
  assert.match(ui, /type="file"/);
  assert.match(ui, /event\.currentTarget\.value = ''/);
  assert.doesNotMatch(ui + browser,
    /localStorage\.|sessionStorage\.|indexedDB\.|FormData\(|navigator\.sendBeacon/);
});
