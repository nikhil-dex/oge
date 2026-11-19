import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID, webcrypto } from 'node:crypto';
import { validatedNote } from '../lib/oge-vault-notes.js';
import { vaultNotesInventorySha256 } from '../lib/oge-vault-backup-export-chunk.js';
import { createVaultNotesChunkSequenceVerifier } from '../lib/oge-vault-backup-chunk-verifier.js';
import {
  MAX_VAULT_BROWSER_EXPORT_PART_BYTES,
  createVaultBrowserChunkDownloadVerifier,
  readLimitedVaultBrowserExportResponse,
  vaultBrowserChunkExportURL,
} from '../lib/oge-vault-browser-chunk-export.js';

const SHA = (v) => createHash('sha1').update(v).digest('hex');
const HASH = (v) => createHash('sha256').update(v).digest('hex');
const sourceHead = SHA('m64-private-snapshot'), subjectId = randomUUID();
const uuid = (i) => i.toString(16).padStart(8, '0') +
  '-0000-4000-8000-' + i.toString(16).padStart(12, '0');

function sample({ count = 130, answerSize = 120 } = {}) {
  const notes = Array.from({ length: count }, (_, i) => ({
    ...validatedNote({
      subjectId, heading: 'PRIVATE HEADING ' + i,
      answer: 'PRIVATE ANSWER ' + 'x'.repeat(answerSize),
      tags: ['notes'], favorite: false,
    }, { id: uuid(i + 1), now: '2026-11-16T13:00:00.000Z' }),
    sha: SHA('m64-original-blob-' + i),
  }));
  const inv = vaultNotesInventorySha256(notes.map(({ id, sha }) => ({ id, sha })));
  const parts = [];
  for (let offset = 0; offset < notes.length || offset === 0; offset += 64) {
    const page = notes.slice(offset, offset + 64);
    const hasMore = offset + page.length < notes.length;
    parts.push({
      format: 'oge-vault-notes-backup-chunk',
      version: 1, scope: 'current-github-notes-only',
      snapshot: sourceHead, totalNotes: notes.length,
      inventorySha256: inv, offset, count: page.length,
      afterId: offset ? notes[offset - 1].id : null,
      nextAfterId: hasMore ? page.at(-1).id : null,
      hasMore,
      coverage: {
        notes: 'partial-immutable-snapshot-chunk',
        historicalRevisions: 'not-included',
        quickNotes: 'not-included',
        airNotes: 'not-included',
        encryptedDrafts: 'not-included',
        learningProgress: 'not-included',
      },
      notes: page,
      chunkSha256: HASH(JSON.stringify(page)),
      completeBackup: false, importableAsLegacyBackup: false,
    });
  }
  return parts;
}
function verifier() {
  return createVaultBrowserChunkDownloadVerifier({ subtle: webcrypto.subtle });
}
async function inspect(parts) {
  const browser = verifier();
  const server = createVaultNotesChunkSequenceVerifier();
  let page = null;
  for (let i = 0; i < parts.length; i++) {
    const url = vaultBrowserChunkExportURL(page);
    assert.equal(url, i === 0 ? '/api/vault/backup-export/chunk'
      : '/api/vault/backup-export/chunk?snapshot=' + sourceHead +
        '&after=' + parts[i - 1].notes.at(-1).id);
    const result = await browser.accept(parts[i]);
    server.accept(parts[i]);
    assert.equal(result.partNumber, i + 1);
    assert.equal(result.complete, !parts[i].hasMore);
    page = { snapshot: result.snapshot,
      nextAfterId: result.nextAfterId };
  }
  const browserResult = await browser.finish();
  const serverResult = server.finish();
  assert.equal(browserResult.notesVerified, serverResult.totalNotes);
  assert.equal(browserResult.partsVerified, serverResult.pages);
  assert.equal(browserResult.inventorySha256, serverResult.inventorySha256);
  return browserResult;
}

test('M64 browser and trusted Node verifier agree on 130-note pinned snapshot sequence', async () => {
  const report = await inspect(sample());
  assert.equal(report.partsVerified, 3);
  assert.equal(report.notesVerified, 130);
  assert.equal(report.verifiedCompleteCurrentNotesSequence, true);
  assert.equal(report.savedToDiskVerified, false);
  assert.equal(report.signedGitHubSourceProvenanceByThisCheck, false);
  assert.equal(report.authorizesRestore, false);
  assert.equal(report.automaticRetryAllowed, false);
  assert.equal(report.filesUploaded, false);
  assert.equal(JSON.stringify(report).includes('PRIVATE ANSWER'), false);
});

test('M64 complete 520-note >8 MiB export verifies nine bounded pages', async () => {
  const parts = sample({ count: 520, answerSize: 16500 });
  assert.ok(parts.reduce((n, part) => n +
    Buffer.byteLength(JSON.stringify(part)), 0) > 8 * 1024 * 1024);
  const result = await inspect(parts);
  assert.equal(result.notesVerified, 520);
  assert.equal(result.partsVerified, 9);
});

test('M64 moving branch HEAD, changed inventory, omitted part and note modification fail closed', async () => {
  const base = sample();
  const variants = [
    (() => { const c = structuredClone(base); c[1].snapshot = SHA('moved-head'); return c; })(),
    (() => { const c = structuredClone(base); c[1].inventorySha256 = 'f'.repeat(64); return c; })(),
    [base[0], base[2]],
    (() => {
      const c = structuredClone(base); c[1].notes[0].answer = 'FORGED PRIVATE CONTENT';
      return c;
    })(),
    (() => { const c = structuredClone(base); c[1].afterId = uuid(3); return c; })(),
  ];
  for (const parts of variants) {
    const v = verifier();
    await assert.rejects((async () => {
      for (const part of parts) await v.accept(part);
      await v.finish();
    })(), TypeError);
  }
});

test('M64 self-consistent forged payload is not GitHub authentication; external signed proof is still required', async () => {
  const forged = structuredClone(sample());
  forged[1].notes[0].answer = 'SELF CONSISTENT FORGED CONTENT';
  forged[1].chunkSha256 = HASH(JSON.stringify(forged[1].notes));
  // Inventory includes self-reported Git blob SHA, not independently
  // authenticated raw Git object bytes. This is why the operator MUST
  // prove source blobs against the signed GitHub App before any restore.
  const v = verifier();
  for (const part of forged) await v.accept(part);
  const result = await v.finish();
  assert.equal(result.verifiedCompleteCurrentNotesSequence, true);
  assert.equal(result.signedGitHubSourceProvenanceByThisCheck, false);
  assert.equal(result.authorizesRestore, false);
});

test('M64 extra fields, invalid canonical notes, false coverage and oversized vaults refused', async () => {
  const base = sample({ count: 1 });
  for (const mutate of [
    (p) => { p.unknown = true; },
    (p) => { p.coverage.quickNotes = 'included'; },
    (p) => { p.notes[0].answer = ''; },
    (p) => { p.notes[0].tags = ['x', 'x']; },
    (p) => { p.notes[0].unknown = 'injection'; },
    (p) => { p.completeBackup = true; },
    (p) => { p.totalNotes = 1025; },
    (p) => { p.notes[0].sha = 'bad'; },
  ]) {
    const changed = structuredClone(base[0]);
    mutate(changed);
    changed.chunkSha256 = HASH(JSON.stringify(changed.notes));
    await assert.rejects(verifier().accept(changed), TypeError);
  }
});

test('M64 incomplete chunks cannot be marked complete or accepted again after final', async () => {
  const parts = sample();
  const v = verifier();
  await v.accept(parts[0]);
  await assert.rejects(v.finish(), TypeError);
  await v.accept(parts[1]);
  await v.accept(parts[2]);
  await v.finish();
  await assert.rejects(v.finish(), TypeError);
  await assert.rejects(v.accept(parts[0]), TypeError);
});

test('M64 stream reader uses limited bytes and rejects oversized, non-JSON or missing response', async () => {
  const part = sample({ count: 1 })[0];
  const response = Response.json(part);
  const parsed = await readLimitedVaultBrowserExportResponse(response);
  assert.deepEqual(parsed.chunk, part);
  assert.equal(parsed.text, JSON.stringify(part));
  await assert.rejects(readLimitedVaultBrowserExportResponse(
    new Response('Unavailable', { status: 429 })), TypeError);
  await assert.rejects(readLimitedVaultBrowserExportResponse(
    new Response('{', { headers: { 'content-type': 'application/json' } })), TypeError);
  await assert.rejects(readLimitedVaultBrowserExportResponse(
    new Response('{}', { headers: {
      'content-type': 'application/json',
      'content-length': String(MAX_VAULT_BROWSER_EXPORT_PART_BYTES + 1),
    } })), TypeError);
  const oversize = new Uint8Array(MAX_VAULT_BROWSER_EXPORT_PART_BYTES + 1);
  await assert.rejects(readLimitedVaultBrowserExportResponse(
    new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(oversize);
        controller.close();
      },
    }), { headers: { 'content-type': 'application/json' } })), TypeError);
});

test('M64 cursor refuses unsupplied, forged or arbitrary revisions', () => {
  assert.equal(vaultBrowserChunkExportURL(null), '/api/vault/backup-export/chunk');
  for (const input of [undefined, {}, {
    snapshot: SHA('fake-snapshot'), nextAfterId: 'bad',
  }, { snapshot: 'invalid', nextAfterId: uuid(1) }])
    assert.throws(() => vaultBrowserChunkExportURL(input), TypeError);
});

test('M64 browser exporter has no Node crypto, MongoDB, GitHub writes or permanent storage', async () => {
  const { readFile } = await import('node:fs/promises');
  const code = await readFile(new URL(
    '../lib/oge-vault-browser-chunk-export.js', import.meta.url), 'utf8');
  assert.match(code, /subtle/);
  assert.match(code, /reader\.read\(\)/);
  assert.match(code, /MAX_VAULT_BROWSER_EXPORT_PART_BYTES/);
  assert.match(code, /signedGitHubSourceProvenanceByThisCheck: false/);
  assert.doesNotMatch(code,
    /node:crypto|node:fs|MongoClient|localStorage|sessionStorage|indexedDB|fetch\(|method: 'POST'|method: 'PATCH'/);
});
