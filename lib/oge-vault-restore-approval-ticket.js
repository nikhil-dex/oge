import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { validateVaultChunkRestoreCommitApproval } from './oge-vault-backup-chunk-restore-execute.js';
import { ownerMutationFilter } from './active-owner-mutation.js';
import { VaultGitHubError } from './oge-vault-github.js';

const SHA = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HEX = /^[a-f0-9]{64}$/;
const MAX_AGE_MS = 10 * 60 * 1000;
const FIELDS = [
  'approval', 'expiresAt', 'installationId', 'issuedAt', 'nonce',
  'ownerId', 'repoId', 'repoName', 'sessionVersion',
].sort();
const fail = (code, status = 409) => new VaultGitHubError(code, status);
const digest = (value) => createHash('sha256')
  .update(JSON.stringify(value)).digest('hex');

function secretKey(secret) {
  if (typeof secret !== 'string' || !HEX.test(secret))
    throw fail('vault-restore-ticket-key-unavailable', 503);
  return Buffer.from(secret, 'hex');
}

function validateIdentity(identity) {
  if (!identity || typeof identity.ownerId !== 'string' ||
      identity.ownerId.length < 1 || identity.ownerId.length > 200 ||
      !(identity.sessionVersion === 0 ||
        typeof identity.sessionVersion === 'string' &&
        UUID.test(identity.sessionVersion)) ||
      !Number.isSafeInteger(identity.repoId) || identity.repoId <= 0 ||
      !Number.isSafeInteger(identity.installationId) ||
      identity.installationId <= 0 ||
      identity.repoName !== 'ogenotes-vault')
    throw fail('vault-restore-ticket-identity-invalid', 400);
  return identity;
}

function validatePayload(payload, now) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      JSON.stringify(Object.keys(payload).sort()) !== JSON.stringify(FIELDS) ||
      !UUID.test(payload.nonce || '') ||
      !Number.isSafeInteger(payload.issuedAt) ||
      !Number.isSafeInteger(payload.expiresAt) ||
      payload.issuedAt > now + 5000 ||
      payload.expiresAt <= now ||
      payload.expiresAt - payload.issuedAt !== MAX_AGE_MS)
    throw fail('vault-restore-ticket-invalid-or-expired', 409);
  validateIdentity(payload);
  validateVaultChunkRestoreCommitApproval(payload.approval);
  return payload;
}

export function issueVaultRestoreApprovalTicket(identity, approval, {
  secret, now = Date.now(), nonce = randomUUID(),
} = {}) {
  validateIdentity(identity);
  const checked = validateVaultChunkRestoreCommitApproval(approval);
  if (!Number.isSafeInteger(now) || !UUID.test(nonce))
    throw new TypeError('Invalid signed receipt issuance');
  const payload = {
    ownerId: identity.ownerId,
    sessionVersion: identity.sessionVersion,
    repoId: identity.repoId,
    installationId: identity.installationId,
    repoName: identity.repoName,
    nonce, issuedAt: now, expiresAt: now + MAX_AGE_MS,
    approval: {
      confirmation: 'COMMIT_VERIFIED_CHUNK_BATCH_CREATE_ONLY',
      expectedSourceSnapshot: checked.expectedSourceSnapshot,
      expectedSourceInventorySha256: checked.expectedSourceInventorySha256,
      expectedTargetHead: checked.expectedTargetHead,
      expectedSelectionFingerprint: checked.expectedSelectionFingerprint,
      selectedIds: checked.selectedIds,
    },
  };
  const packed = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', secretKey(secret))
    .update('oge-vault-restore-approval-m59-v1.').update(packed)
    .digest('hex');
  return {
    ticket: packed + '.' + mac,
    nonceHash: digest(nonce),
    approvalHash: digest(payload.approval),
    expiresAt: new Date(payload.expiresAt),
  };
}

export function verifyVaultRestoreApprovalTicket(ticket, identity, {
  secret, now = Date.now(),
} = {}) {
  validateIdentity(identity);
  if (typeof ticket !== 'string' || ticket.length > 4096 ||
      !/^[A-Za-z0-9_-]{60,3900}\.[a-f0-9]{64}$/.test(ticket))
    throw fail('vault-restore-ticket-invalid-or-expired');
  const [packed, signedMac] = ticket.split('.');
  const expected = createHmac('sha256', secretKey(secret))
    .update('oge-vault-restore-approval-m59-v1.').update(packed)
    .digest();
  if (!timingSafeEqual(expected, Buffer.from(signedMac, 'hex')))
    throw fail('vault-restore-ticket-invalid-or-expired');
  let payload;
  try {
    const decoded = Buffer.from(packed, 'base64url');
    if (decoded.toString('base64url') !== packed)
      throw new TypeError('Noncanonical receipt');
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded));
  } catch {
    throw fail('vault-restore-ticket-invalid-or-expired');
  }
  validatePayload(payload, now);
  if (payload.ownerId !== identity.ownerId ||
      payload.sessionVersion !== identity.sessionVersion ||
      payload.repoId !== identity.repoId ||
      payload.installationId !== identity.installationId ||
      payload.repoName !== identity.repoName)
    throw fail('vault-restore-ticket-owner-or-repository-changed');
  return {
    approval: payload.approval, nonceHash: digest(payload.nonce),
    approvalHash: digest(payload.approval), expiresAt: payload.expiresAt,
  };
}

/**
 * Durable metadata-only owner/nonce state; never notes, archive bytes, titles,
 * answers, or GitHub credentials. Claim is ATOMIC and ONE-TIME before any
 * private GitHub write. Failure after claim is not eligible for retry.
 */
export async function recordVaultRestoreApproval(db, identity, receipt, {
  now = new Date(),
} = {}) {
  validateIdentity(identity);
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      !HEX.test(receipt?.nonceHash || '') ||
      !HEX.test(receipt?.approvalHash || '') ||
      !(receipt.expiresAt instanceof Date) ||
      receipt.expiresAt <= now)
    throw new TypeError('Invalid signed staging approval record');
  // Confirm this exact session still exists before storing the receipt.
  const owner = await db.collection('users').findOne({
    ...ownerMutationFilter(identity.ownerId, {
      sessionVersion: identity.sessionVersion,
    }),
    'vault.status': 'connected',
    'vault.repoId': identity.repoId,
    'vault.installationId': identity.installationId,
    'vault.repoName': identity.repoName,
    // A suspected GitHub write must be investigated independently before
    // the browser can issue another approval on this signed Vault.
    vaultImportLock: { $exists: false },
  }, { projection: { _id: 1 } });
  if (!owner) throw fail('vault-restore-ticket-owner-or-repository-changed');

  const approvals = db.collection('vault_restore_approvals');
  // Only a CONFIRMED prior commit (or an unused/expired receipt) may
  // precede another independently approved batch. A CLAIMED receipt may
  // have completed remotely even if MongoDB never received confirmation.
  if (await approvals.findOne({
    ownerId: identity.ownerId,
    sessionVersion: identity.sessionVersion,
    repoId: identity.repoId,
    installationId: identity.installationId,
    state: 'claimed',
  }, { projection: { _id: 1 } }))
    throw fail('vault-restore-previous-batch-unconfirmed');

  // Expired metadata is retained only for a bounded staging incident
  // review window. The expiry predicate itself is enforced on EVERY claim;
  // MongoDB's TTL monitor is not relied upon for authorization decisions.
  await approvals.createIndex({ expiresAt: 1 }, {
    name: 'vault_restore_approval_expiration_v1',
    expireAfterSeconds: 7 * 24 * 60 * 60,
  });
  // M60: bounded owner-scoped history walks exactly this indexed
  // ordering; never scan or enumerate another account's receipts.
  await approvals.createIndex({
    ownerId: 1, sessionVersion: 1, repoId: 1,
    installationId: 1, createdAt: -1, _id: -1,
  }, { name: 'vault_restore_owner_recent_batches_v1' });
  // MongoDB's built-in unique _id index makes nonce replay impossible
  // even if a caller tries to mint two tickets with the same nonce.
  await approvals.insertOne({
    _id: receipt.nonceHash,
    ownerId: identity.ownerId,
    sessionVersion: identity.sessionVersion,
    repoId: identity.repoId,
    installationId: identity.installationId,
    nonceHash: receipt.nonceHash,
    approvalHash: receipt.approvalHash,
    createdAt: now,
    expiresAt: receipt.expiresAt,
    state: 'pending',
  });
  return { status: 'pending', expiresAt: receipt.expiresAt };
}

export async function claimVaultRestoreApprovalOnce(db, identity, verified, {
  now = new Date(),
} = {}) {
  validateIdentity(identity);
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      !HEX.test(verified?.nonceHash || '') ||
      !HEX.test(verified?.approvalHash || ''))
    throw new TypeError('Invalid one-time restore ticket claim');
  const row = await db.collection('vault_restore_approvals').findOneAndUpdate({
    ownerId: identity.ownerId,
    sessionVersion: identity.sessionVersion,
    repoId: identity.repoId,
    installationId: identity.installationId,
    _id: verified.nonceHash,
    nonceHash: verified.nonceHash,
    approvalHash: verified.approvalHash,
    expiresAt: { $gt: now },
    state: 'pending',
  }, { $set: { state: 'claimed', claimedAt: now } },
  { returnDocument: 'after' });
  if (!row || row.state !== 'claimed')
    throw fail('vault-restore-approval-already-used-or-expired');
  return { claimed: true, oneTimeOnly: true, autoRetryAllowed: false };
}

export async function confirmVaultRestoreApproval(db, identity, verified,
  commitSha, { now = new Date() } = {}) {
  validateIdentity(identity);
  if (!SHA.test(commitSha || '') || !(now instanceof Date))
    throw new TypeError('Invalid verified restore commit');
  const update = await db.collection('vault_restore_approvals').updateOne({
    ownerId: identity.ownerId,
    sessionVersion: identity.sessionVersion,
    repoId: identity.repoId,
    installationId: identity.installationId,
    nonceHash: verified.nonceHash,
    approvalHash: verified.approvalHash,
    state: 'claimed',
  }, { $set: { state: 'confirmed', confirmedAt: now, commitSha } });
  if (update.matchedCount !== 1)
    throw fail('vault-restore-confirmation-audit-unconfirmed', 503);
  return { confirmed: true, commitSha, autoRetryAllowed: false };
}
