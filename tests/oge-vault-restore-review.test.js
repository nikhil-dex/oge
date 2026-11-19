import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  buildVaultRestoreReviewApproval,
  classifyVaultRestoreReviewHistory,
} from '../lib/oge-vault-restore-review.js';
import {
  validateVaultChunkRestoreCommitApproval,
} from '../lib/oge-vault-backup-chunk-restore-execute.js';

const SHA = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);
const FP = 'c'.repeat(64);
const ids = [randomUUID(), randomUUID()];
const fields = () => ({
  sourceSnapshot: SHA,
  inventoryDigest: DIGEST, targetHead: SHA,
  fingerprint: FP, selectedIdsText: ids.join('\n'),
});
const history = (status, overrides = {}) => ({
  format: 'oge-vault-restore-batch-history-read-only', version: 1,
  status, readOnly: true, historyTruncated: false,
  currentGitHubHeadVerified: false, historicalTotalsProven: false,
  automaticRetryAuthorized: false,
  automaticNextBatchAuthorized: false,
  operatorLockReleaseAuthorized: false,
  batches: [], ...overrides,
});

test('M62 exact owner-reviewed selection maps to existing separately approved M58 request schema', () => {
  const approval = buildVaultRestoreReviewApproval(fields());
  assert.equal(approval.confirmation, 'COMMIT_VERIFIED_CHUNK_BATCH_CREATE_ONLY');
  assert.deepEqual(approval.selectedIds, ids);
  assert.equal(approval.expectedTargetHead, SHA);
  assert.equal(approval.expectedSourceSnapshot, SHA);
  assert.equal(approval.expectedSourceInventorySha256, DIGEST);
  assert.equal(approval.expectedSelectionFingerprint, FP);
  assert.equal(Object.keys(approval).length, 6);
  assert.deepEqual(
    validateVaultChunkRestoreCommitApproval(approval).selectedIds, ids);
});

test('M62 browser review allows only 1–12 distinct lower-case selected note UUIDs', () => {
  for (const invalid of [
    '', ' ', 'not-a-uuid',
    ids.join(',') + ',' + ids[0],
    ids[0].toUpperCase(),
    Array.from({ length: 13 }, () => randomUUID()).join('\n'),
    'a'.repeat(601),
    '   ' + ids[0] + ' additional-private-note-content',
  ]) {
    assert.throws(() => buildVaultRestoreReviewApproval({
      ...fields(), selectedIdsText: invalid,
    }), TypeError);
  }
  const exact = buildVaultRestoreReviewApproval({
    ...fields(), selectedIdsText: ids.join(',\n'),
  });
  assert.deepEqual(exact.selectedIds, ids);
});

test('M62 browser rejects malformed signed source/target SHA and forged content fingerprint', () => {
  for (const key of ['sourceSnapshot', 'targetHead',
    'inventoryDigest', 'fingerprint']) {
    for (const value of ['', 'A'.repeat(key.includes('Digest') ||
      key === 'fingerprint' ? 64 : 40),
    'g'.repeat(64), ' ' + SHA, SHA + '\n']) {
      assert.throws(() => buildVaultRestoreReviewApproval({
        ...fields(), [key]: value,
      }), TypeError);
    }
  }
});

test('M62 only independently reviewed states may request a ticket; current GitHub revision is never assumed verified', () => {
  for (const state of ['NO_RESTORE_BATCHES_FOUND',
    'CONFIRMED_BATCHES_FRESH_REVIEW_REQUIRED',
    'EXPIRED_APPROVAL_REQUIRES_NEW_REVIEW']) {
    const report = classifyVaultRestoreReviewHistory(history(state));
    assert.equal(report.canRequestReceipt, true);
  }
  for (const state of [
    'PENDING_UNCONSUMED_APPROVAL',
    'BLOCKED_CLAIMED_OUTCOME_UNCONFIRMED',
    'BLOCKED_IMPORT_LOCK_PRESENT',
    'BLOCKED_INCOMPLETE_HISTORY_WINDOW',
    'BLOCKED_INVALID_HISTORY_METADATA',
  ]) {
    const report = classifyVaultRestoreReviewHistory(history(state));
    assert.equal(report.canRequestReceipt, false);
  }
});

test('M62 invalid, incomplete or optimistic metadata never enables browser approval', () => {
  for (const report of [
    null, {}, history('NEW_UNRECOGNIZED_STATE'),
    history('CONFIRMED_BATCHES_FRESH_REVIEW_REQUIRED',
      { historyTruncated: true }),
    history('NO_RESTORE_BATCHES_FOUND', { currentGitHubHeadVerified: true }),
    history('NO_RESTORE_BATCHES_FOUND', { automaticRetryAuthorized: true }),
    history('NO_RESTORE_BATCHES_FOUND', { automaticNextBatchAuthorized: true }),
    history('NO_RESTORE_BATCHES_FOUND', { operatorLockReleaseAuthorized: true }),
    history('NO_RESTORE_BATCHES_FOUND', { readOnly: false }),
    history('NO_RESTORE_BATCHES_FOUND', { batches: null }),
  ]) assert.equal(classifyVaultRestoreReviewHistory(report).canRequestReceipt,
    false);
});

test('M62 browser page is server-side hidden behind full isolated staging preflight and authenticated session', async () => {
  const page = await readFile(new URL(
    '../app/vault/restore-staging/page.js', import.meta.url), 'utf8');
  assert.match(page, /checkVaultStagingReadiness\(env\)\.ok/);
  assert.match(page, /OGE_VAULT_CHUNK_RESTORE_APPROVAL_PREVIEW !== 'true'/);
  assert.match(page, /oge_vault_restore_staging_/);
  assert.match(page, /if \(!stagingAllowed\(process\.env\)\) notFound\(\)/);
  assert.match(page, /const session = await auth\(\)/);
  assert.match(page, /if \(!session\?\.user\?\.id\) redirect/);
  assert.match(page, /ownerMutationFilter\(session\.user\.id/);
  assert.match(page, /'vault.status': 'connected'/);
  assert.match(page, /robots: \{ index: false, follow: false \}/);
  assert.match(page, /OGE_VAULT_BACKUP_IMPORT_COMMIT_PREVIEW !== 'true'/);
  assert.doesNotMatch(page,
    /getVaultNoteClient|commitVaultNoteBatch|\.insertOne\(|\.updateOne\(|\.deleteOne\(/);
});

test('M62 accessible staged owner client never auto-issues a ticket, uploads archives or persists credentials', async () => {
  const client = await readFile(new URL(
    '../app/vault/restore-staging/restore-review-client.js', import.meta.url), 'utf8');
  assert.match(client, /classifyVaultRestoreReviewHistory\(history\)/);
  assert.match(client, /buildVaultRestoreReviewApproval\(fields\)/);
  assert.match(client, /typedConfirmation === 'APPROVE ONE BATCH'/);
  assert.match(client, /const \[reviewed, setReviewed\] = useState\(false\)/);
  assert.match(client, /useEffect\(\(\) => \{/);
  assert.match(client, /method: 'POST'/);
  assert.match(client, /async function requestReceipt\(event\)/);
  assert.match(client, /onSubmit=\{requestReceipt\}/);
  assert.match(client, /navigator\.clipboard\.writeText/);
  assert.match(client, /'cache': 'no-store'|cache: 'no-store'/);
  assert.match(client, /Do not automatically retry/);
  assert.doesNotMatch(client,
    /localStorage|sessionStorage|IndexedDB|FileReader|readAsText|fetch\(.*blobs|fetch\(.*contents|dangerouslySetInnerHTML/);
});

test('M62 link to restore review remains invisible outside isolated approved staging', async () => {
  const page = await readFile(new URL(
    '../app/vault/page.js', import.meta.url), 'utf8');
  assert.match(page, /restoreStagingVisible && <Link/);
  assert.match(page, /href="\/vault\/restore-staging"/);
  for (const flag of [
    'OGE_VAULT_CHUNK_RESTORE_APPROVAL_PREVIEW',
    'OGE_VAULT_NOTE_API_PREVIEW',
    'OGE_VAULT_BACKUP_IMPORT_PLAN_PREVIEW',
    'OGE_VAULT_BACKUP_IMPORT_COMMIT_PREVIEW',
  ]) assert.ok(page.includes('process.env.' + flag + " === 'true'"));
  assert.match(page, /checkVaultStagingReadiness\(process\.env\)\.ok/);
});

test('M63 owner UI requires all local chunks matching reviewed M57 fingerprint before a receipt POST', async () => {
  const source = await readFile(new URL(
    '../app/vault/restore-staging/restore-review-client.js', import.meta.url),
  'utf8');
  assert.match(source, /verifyVaultRestoreLocalChunkFiles/);
  assert.match(source, /const locallyVerified =/);
  assert.match(source, /localIntegrity\?\.reviewKey === JSON\.stringify\(fields\)/);
  assert.match(source, /completeLocalSequenceVerified === true/);
  assert.match(source, /reviewedSelectionFingerprintMatches === true/);
  assert.match(source, /signedGitHubSourceAuthenticated === false/);
  assert.match(source, /review\.canRequestReceipt && locallyVerified && reviewed/);
  assert.match(source, /type="file" accept="\.json,application\/json" multiple/);
  assert.match(source, /onClick=\{verifyLocalBackupFiles\}/);
  assert.match(source, /setLocalIntegrity\(null\)/);
  assert.match(source, /Files are never uploaded/);
  assert.match(source, /This does not prove signed GitHub provenance/);
  assert.doesNotMatch(source,
    /FormData|XMLHttpRequest|localStorage|sessionStorage|indexedDB|fetch\(.*files/);
});

test('M63 unknown browser approval POST outcome cannot be replayed in the same review session', async () => {
  const source = await readFile(new URL(
    '../app/vault/restore-staging/restore-review-client.js', import.meta.url),
  'utf8');
  assert.match(source, /const \[receiptAttempted, setReceiptAttempted\] = useState\(false\)/);
  assert.match(source, /!receiptAttempted && !receipt/);
  assert.match(source, /setReceiptAttempted\(true\)/);
  assert.ok(source.indexOf('setReceiptAttempted(true)') <
    source.indexOf('const response = await fetch(approveEndpoint'));
  assert.match(source, /do not replay an unknown POST response/);
});
