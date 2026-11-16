import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  issueVaultRestoreApprovalTicket, verifyVaultRestoreApprovalTicket,
} from '../lib/oge-vault-restore-approval-ticket.js';

const SECRET = 'ba'.repeat(32);
const NOW = Date.parse('2026-11-16T13:30:00Z');
const SHA = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);
const identity = () => ({
  ownerId: 'synthetic-' + randomUUID(),
  sessionVersion: randomUUID(),
  repoId: 4738, installationId: 59, repoName: 'ogenotes-vault',
});
const approval = (selectedIds = [randomUUID()]) => ({
  confirmation: 'COMMIT_VERIFIED_CHUNK_BATCH_CREATE_ONLY',
  expectedSourceSnapshot: SHA,
  expectedSourceInventorySha256: DIGEST,
  expectedTargetHead: SHA,
  selectedIds,
  expectedSelectionFingerprint: 'c'.repeat(64),
});

test('M59 one-time approval ticket is HMAC signed, exact owner/install scoped and ten-minute bounded', () => {
  const owner = identity(), selected = approval();
  const issued = issueVaultRestoreApprovalTicket(owner, selected, {
    secret: SECRET, now: NOW, nonce: randomUUID(),
  });
  assert.match(issued.ticket, /^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/);
  assert.match(issued.nonceHash, /^[a-f0-9]{64}$/);
  assert.equal(issued.expiresAt.toISOString(), '2026-11-16T13:40:00.000Z');
  const verified = verifyVaultRestoreApprovalTicket(issued.ticket, owner, {
    secret: SECRET, now: NOW + 120000,
  });
  assert.deepEqual(verified.approval, selected);
  assert.equal(verified.nonceHash, issued.nonceHash);
  assert.equal(verified.approvalHash, issued.approvalHash);
  assert.equal(verified.expiresAt, NOW + 600000);
  assert.equal(JSON.stringify(verified).includes('PRIVATE USER NOTE'), false);
});

test('M59 ticket rejects changes of authenticated user, session, repository or installation', () => {
  const owner = identity(), issued = issueVaultRestoreApprovalTicket(
    owner, approval(), { secret: SECRET, now: NOW });
  for (const bad of [
    { ...owner, ownerId: 'different-owner' },
    { ...owner, sessionVersion: randomUUID() },
    { ...owner, repoId: owner.repoId + 1 },
    { ...owner, installationId: owner.installationId + 1 },
    { ...owner, repoName: 'other-vault' },
  ]) assert.throws(() => verifyVaultRestoreApprovalTicket(
    issued.ticket, bad, { secret: SECRET, now: NOW + 2000 }));
});

test('M59 ticket blocks forged HMAC, changed content, bad key and expired/future receipts', () => {
  const owner = identity(), issued = issueVaultRestoreApprovalTicket(
    owner, approval(), { secret: SECRET, now: NOW });
  const [packed, mac] = issued.ticket.split('.');
  const alteredPayload = Buffer.from(JSON.stringify({
    ...JSON.parse(Buffer.from(packed, 'base64url').toString()),
    installationId: 999,
  })).toString('base64url');
  for (const token of [
    packed + '.' + '0'.repeat(64),
    alteredPayload + '.' + mac,
    issued.ticket + 'trailing',
    'invalid.',
    issued.ticket.slice(0, -1) + (mac.at(-1) === 'a' ? 'b' : 'a'),
  ]) assert.throws(() => verifyVaultRestoreApprovalTicket(
    token, owner, { secret: SECRET, now: NOW + 1000 }));
  assert.throws(() => verifyVaultRestoreApprovalTicket(
    issued.ticket, owner, { secret: SECRET, now: NOW + 600000 }));
  assert.throws(() => verifyVaultRestoreApprovalTicket(
    issued.ticket, owner, { secret: SECRET, now: NOW - 30000 }));
  assert.throws(() => verifyVaultRestoreApprovalTicket(
    issued.ticket, owner, { secret: 'invalid', now: NOW + 1000 }));
  assert.throws(() => issueVaultRestoreApprovalTicket(
    owner, approval(), { secret: 'fake', now: NOW }));
});

test('M59 exact bounded restore confirmation required; read-only M57 fingerprint cannot itself issue receipt', () => {
  const owner = identity();
  for (const invalid of [
    { ...approval(), confirmation: 'PREPARE_CREATE_ONLY_RESTORE_BATCH' },
    { ...approval(), selectedIds: [] },
    { ...approval(), selectedIds: Array.from({ length: 13 }, () => randomUUID()) },
    { ...approval(), expectedSelectionFingerprint: 'not-a-digest' },
    { ...approval(), unexpected: 'field' },
  ]) assert.throws(() => issueVaultRestoreApprovalTicket(owner, invalid, {
    secret: SECRET, now: NOW,
  }));
});

test('M59 signed approval API never uploads private notes, never calls GitHub writer, is same-origin and default-off', async () => {
  const route = await readFile(new URL(
    '../app/api/vault/backup-import/chunk/authorize/route.js', import.meta.url),
  'utf8');
  assert.match(route, /const session = await auth\(\)/);
  assert.match(route, /getVaultNoteClient\(db, \{/);
  assert.match(route, /readOnly: true/);
  assert.match(route, /request\.headers\.get\('origin'\)/);
  assert.match(route, /OGE_VAULT_CHUNK_RESTORE_APPROVAL_PREVIEW !== 'true'/);
  assert.match(route, /oge_vault_restore_staging_/);
  assert.match(route, /checkVaultStagingReadiness\(env\)\.ok/);
  assert.match(route, /readLimitedBody\(request, 4096\)/);
  assert.match(route, /immediatelyExecutesRestore: false/);
  assert.doesNotMatch(route, /commitVaultNoteBatch|executeApprovedVaultChunkRestoreBatch/);
  assert.doesNotMatch(route, /collection\('notes'\)|createNote|deleteOne\(/);
});
