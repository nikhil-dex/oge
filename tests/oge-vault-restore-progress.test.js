import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describeVaultRestoreApprovalStatus } from '../lib/oge-vault-restore-progress.js';

const now = new Date('2026-11-16T14:00:00Z');
const expiresAt = new Date('2026-11-16T14:05:00Z');

test('M59 owner status redacts pending, claimed and confirmed receipt states', () => {
  const pending = describeVaultRestoreApprovalStatus({
    state: 'pending', expiresAt, noteText: 'SECRET PRIVATE NOTE',
    selectedIds: ['private-id'],
  }, { now });
  assert.equal(pending.status, 'PENDING_APPROVAL_CLAIM');
  assert.equal(pending.receiptExpired, false);
  assert.equal(pending.canRetryAutomatically, false);
  assert.equal(pending.nextBatchAutomaticallyStarted, false);
  assert.equal(pending.canUnlockImport, false);
  assert.equal(pending.confirmedCommitSha, undefined);

  const claimed = describeVaultRestoreApprovalStatus({
    state: 'claimed', expiresAt,
    secretToken: 'PRIVATE_HMAC_TICKET',
    userId: 'private-owner',
  }, { now });
  assert.equal(claimed.status,
    'CLAIMED_OUTCOME_REQUIRES_REVIEW_IF_INTERRUPTED');
  assert.equal(claimed.operatorReviewRequiredIfInterrupted, true);
  assert.equal(claimed.canRetryAutomatically, false);
  assert.equal(claimed.canUnlockImport, false);

  const confirmed = describeVaultRestoreApprovalStatus({
    state: 'confirmed', expiresAt, commitSha: 'a'.repeat(40),
    rawNote: 'SECRET PRIVATE NOTE',
  }, { now });
  assert.equal(confirmed.status, 'GITHUB_BATCH_CONFIRMED');
  assert.equal(confirmed.confirmedCommitSha, 'a'.repeat(40));
  assert.equal(confirmed.operatorReviewRequiredIfInterrupted, false);
  assert.equal(confirmed.sourceNoteContentReturned, false);
  for (const value of [pending, claimed, confirmed]) {
    const serialized = JSON.stringify(value);
    for (const secret of ['SECRET PRIVATE NOTE',
      'PRIVATE_HMAC_TICKET', 'private-owner', 'private-id'])
      assert.equal(serialized.includes(secret), false);
  }
});

test('M59 expired pending receipt is never portrayed as a fresh write authorization', () => {
  const out = describeVaultRestoreApprovalStatus({
    state: 'pending', expiresAt,
  }, { now: new Date('2026-11-16T14:06:00Z') });
  assert.equal(out.receiptExpired, true);
  assert.equal(out.canRetryAutomatically, false);
});

test('M59 malformed claimed or confirmed metadata cannot produce false success', () => {
  for (const record of [
    null, {}, { state: 'unknown', expiresAt },
    { state: 'confirmed', expiresAt, commitSha: 'invalid' },
    { state: 'claimed', expiresAt: 'invalid' },
  ]) assert.throws(() => describeVaultRestoreApprovalStatus(record), TypeError);
});

test('M59 status endpoint scopes every receipt to signed owner/session/repo/install, never calls GitHub or mutates content', async () => {
  const code = await readFile(new URL(
    '../app/api/vault/backup-import/chunk/status/route.js', import.meta.url), 'utf8');
  assert.match(code, /const session = await auth\(\)/);
  assert.match(code, /ownerMutationFilter\(ownerId, \{ sessionVersion \}\)/);
  assert.match(code, /_id: url\.searchParams\.get\('receiptId'\)/);
  assert.match(code, /repoId: vault\.repoId/);
  assert.match(code, /installationId: vault\.installationId/);
  assert.match(code, /checkVaultStagingReadiness\(env\)\.ok/);
  assert.match(code, /private, no-store/);
  assert.match(code, /describeVaultRestoreApprovalStatus\(record\)/);
  assert.doesNotMatch(code, /commitVaultNoteBatch|getVaultNoteClient|\\.updateOne\(|\\.insertOne\(|\\.deleteOne\(/);
});
