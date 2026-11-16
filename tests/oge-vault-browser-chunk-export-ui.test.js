import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('M64 owner export UI only appears inside authenticated isolated staging restore page', async () => {
  const page = await readFile(new URL(
    '../app/vault/restore-staging/page.js', import.meta.url), 'utf8');
  assert.match(page, /const session = await auth\(\)/);
  assert.match(page, /ownerMutationFilter\(session.user.id/);
  assert.match(page, /'vault.status': 'connected'/);
  assert.match(page, /if \(!owner\) notFound\(\)/);
  assert.match(page, /checkVaultStagingReadiness\(env\)\.ok/);
  assert.match(page, /OGE_VAULT_BACKUP_EXPORT_PREVIEW === 'true'/);
  assert.match(page, /OGE_VAULT_BACKUP_EXPORT_CHUNK_PREVIEW === 'true'/);
  assert.match(page, /VaultBackupDownloadClient enabled=\{chunkExportEnabled\}/);
  assert.doesNotMatch(page, /getVaultNoteClient|commitVaultNoteBatch|\.insertOne\(/);
});

test('M64 private Notes chunk download is always explicit, one attempt and bounded to 16 GETs', async () => {
  const ui = await readFile(new URL(
    '../app/vault/restore-staging/vault-backup-download-client.js', import.meta.url), 'utf8');
  assert.match(ui, /const \[attempted, setAttempted\] = useState\(false\)/);
  assert.match(ui, /if \(!enabled \|\| attempted \|\| running \|\|/);
  assert.match(ui, /setAttempted\(true\)/);
  assert.match(ui, /for \(let index = 1; index <= 16; index\+\+\)/);
  assert.match(ui, /vaultBrowserChunkExportURL\(cursor\)/);
  assert.match(ui, /readLimitedVaultBrowserExportResponse/);
  assert.match(ui, /await verifier.accept\(chunk\)/);
  assert.match(ui, /await verifier.finish\(\)/);
  assert.match(ui, /abort.signal.aborted \|\| !completed/);
  assert.match(ui, /method: 'GET'/);
  assert.match(ui, /credentials: 'same-origin'/);
  assert.match(ui, /cache: 'no-store'/);
  assert.match(ui, /headers: \{ Accept: 'application\/json' \}/);
  assert.doesNotMatch(ui, /method: 'POST'|method: 'PATCH'|setInterval/);
});

test('M64 browser never claims that a programmatic download proves actual local disk persistence', async () => {
  const ui = await readFile(new URL(
    '../app/vault/restore-staging/vault-backup-download-client.js', import.meta.url), 'utf8');
  assert.match(ui, /new Blob\(\[sealed.text\], \{ type: 'application\/json' \}\)/);
  assert.match(ui, /URL.createObjectURL\(blob\)/);
  assert.match(ui, /link.download = sealed.filename/);
  assert.match(ui, /URL.revokeObjectURL\(url\)/);
  assert.match(ui, /every.*file.*actually saved|actually saved/);
  assert.match(ui, /No request was automatically retried/);
  assert.match(ui, /start a fresh reviewed session/);
  assert.match(ui, /This does not include revisions, Quick Notes, AirNotes/);
  assert.match(ui, /This is not\s+confirmation that your browser saved every file/);
  assert.doesNotMatch(ui,
    /localStorage|sessionStorage|indexedDB|navigator.sendBeacon|XMLHttpRequest|FormData|navigator.serviceWorker|commitVaultNoteBatch/);
});

test('M64 all source content remains in browser and GitHub; no backup JSON or Note text in Mongo', async () => {
  const ui = await readFile(new URL(
    '../app/vault/restore-staging/vault-backup-download-client.js', import.meta.url), 'utf8');
  const helper = await readFile(new URL(
    '../lib/oge-vault-browser-chunk-export.js', import.meta.url), 'utf8');
  const api = await readFile(new URL(
    '../app/api/vault/backup-export/chunk/route.js', import.meta.url), 'utf8');
  assert.match(api, /getVaultNoteClient\(db,/);
  assert.match(api, /readOnly: true/);
  assert.match(api, /OGE_VAULT_BACKUP_EXPORT_CHUNK_PREVIEW !== 'true'/);
  assert.match(api, /ownerMutationFilter\(ownerId, \{ sessionVersion \}\)/);
  assert.match(api, /'Cache-Control': 'private, no-store'/);
  assert.match(helper, /signedGitHubSourceProvenanceByThisCheck: false/);
  assert.match(helper, /savedToDiskVerified: false/);
  assert.match(helper, /historicalRevisionsIncluded: false/);
  assert.doesNotMatch(ui + helper, /MongoClient|getDatabase|\.updateOne\(|\.insertOne\(|\.deleteOne\(/);
});


test('M65 encrypted backup export is the only default disk path; no plaintext Blob is ever offered', async () => {
  const ui = await readFile(new URL(
    '../app/vault/restore-staging/vault-backup-download-client.js',
    import.meta.url), 'utf8');
  assert.match(ui, /createVaultOfflineEncryptSession\(passphrase\)/);
  assert.match(ui, /await encryptor\.seal\(text, accepted\.partNumber\)/);
  assert.match(ui, /const blob = new Blob\(\[sealed\.text\]/);
  assert.match(ui, /link\.download = sealed\.filename/);
  assert.match(ui, /setPassphrase\(''\)/);
  assert.match(ui, /setRepeatPassphrase\(''\)/);
  assert.match(ui, /passphrase\.length < 16/);
  assert.match(ui, /passphrase !== repeatPassphrase/);
  assert.match(ui, /type="password"/);
  assert.match(ui, /encrypted private Notes chunks/);
  assert.doesNotMatch(ui, /new Blob\(\[text\]/);
  assert.doesNotMatch(ui, /link\.download = 'part-'/);
});

test('M65 restore staging decrypts encrypted .oge.json pages only in transient memory before exact M63 verifier', async () => {
  const review = await readFile(new URL(
    '../app/vault/restore-staging/restore-review-client.js',
    import.meta.url), 'utf8');
  assert.match(review, /openVaultOfflineEncryptedFiles\(localFiles, offlinePassphrase\)/);
  assert.match(review, /verifyVaultRestoreLocalChunkFiles\(\s*verifiedFiles, fields\)/);
  assert.match(review, /localFiles\.every\(\(file\) => \/\^part-/);
  assert.match(review, /setOfflinePassphrase\(''\)/);
  assert.match(review, /type="password" name="offline-restore-passphrase"/);
  assert.match(review, /Never mix the two formats/);
  assert.match(review, /No note bodies,\s+passphrases or filenames will be sent to the server/);
  assert.doesNotMatch(review, /new Blob\(|FormData|XMLHttpRequest|localStorage|sessionStorage|indexedDB/);
});
