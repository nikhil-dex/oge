import {
  createHash, createHmac, randomUUID, timingSafeEqual,
} from 'node:crypto';
import { ownerMutationFilter } from './active-owner-mutation.js';
import { validateStandaloneRestoreSelection } from './oge-vault-standalone-restore-approval.js';
import { VaultGitHubError } from './oge-vault-github.js';

/**
 * E8/M76: Standalone-only, 10-minute HMAC-SHA256 receipt and atomic
 * MongoDB one-time claim ledger. Separate from D3 Notes restore tickets:
 * no cross-kind token reuse, no Notes import, no archives or private
 * bodies/titles stored in MongoDB. A receipt is NOT source authenticity.
 */
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const LOGIN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;
const TEN_MINUTES = 10 * 60 * 1000;
const PREFIX = 'oge-vault-standalone-restore-ticket-m76-v1.';
const fail = (code, status = 409) => new VaultGitHubError(code, status);
const digest = (value) => createHash('sha256')
  .update(JSON.stringify(value), 'utf8').digest('hex');
const sameKeys = (value, fields) =>
  value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...fields].sort().join(',');

function secretKey(secret) {
  if (typeof secret !== 'string' || !HASH.test(secret))
    throw fail('vault-standalone-ticket-secret-unavailable', 503);
  return Buffer.from(secret, 'hex');
}

export function standaloneRestoreTicketIdentity(identity, client) {
  const vault = client?.vault;
  const built = {
    ownerId: identity?.ownerId,
    sessionVersion: identity?.sessionVersion,
    repoId: vault?.repoId,
    installationId: vault?.installationId,
    repoName: vault?.repoName,
    githubAccountId: vault?.githubAccountId,
    githubLogin: vault?.githubLogin,
  };
  validateIdentity(built);
  return built;
}

function validateIdentity(identity) {
  if (!sameKeys(identity, [
    'ownerId', 'sessionVersion', 'repoId', 'installationId',
    'repoName', 'githubAccountId', 'githubLogin',
  ]) || typeof identity.ownerId !== 'string' ||
      identity.ownerId.length < 1 || identity.ownerId.length > 200 ||
      !(identity.sessionVersion === 0 ||
        typeof identity.sessionVersion === 'string' &&
        UUID.test(identity.sessionVersion)) ||
      !Number.isSafeInteger(identity.repoId) || identity.repoId <= 0 ||
      !Number.isSafeInteger(identity.installationId) ||
      identity.installationId <= 0 ||
      identity.repoName !== 'ogenotes-vault' ||
      !/^[1-9][0-9]*$/.test(identity.githubAccountId || '') ||
      !LOGIN.test(identity.githubLogin || ''))
    throw fail('vault-standalone-ticket-identity-invalid', 400);
}

export function standaloneRestoreApprovalBinding(request) {
  const selection = validateStandaloneRestoreSelection(request, {
    commit: true,
  });
  return {
    kind: selection.kind,
    selectedIds: [...selection.selectedIds],
    expectedTargetHead: selection.expectedTargetHead,
    expectedSelectionFingerprint: request.expectedSelectionFingerprint,
    sourceSnapshot: selection.sourceSnapshot,
    sourceArchiveSha256: selection.sourceArchiveSha256,
    confirmation: 'COMMIT_SELECTED_STANDALONE_CREATE_ONLY',
  };
}

function validateBinding(value) {
  if (!sameKeys(value, [
    'kind', 'selectedIds', 'expectedTargetHead',
    'expectedSelectionFingerprint', 'sourceSnapshot',
    'sourceArchiveSha256', 'confirmation',
  ]) || !['quick-notes', 'airnotes'].includes(value.kind) ||
      value.confirmation !== 'COMMIT_SELECTED_STANDALONE_CREATE_ONLY' ||
      !Array.isArray(value.selectedIds) || value.selectedIds.length < 1 ||
      value.selectedIds.length > 12 ||
      value.selectedIds.some((id) => !UUID.test(id || '')) ||
      new Set(value.selectedIds).size !== value.selectedIds.length ||
      !SHA.test(value.expectedTargetHead || '') ||
      !SHA.test(value.sourceSnapshot || '') ||
      !HASH.test(value.sourceArchiveSha256 || '') ||
      !HASH.test(value.expectedSelectionFingerprint || ''))
    throw fail('vault-standalone-ticket-binding-invalid', 400);
  return value;
}

export function issueStandaloneRestoreTicket(identity, binding, {
  secret, now = Date.now(), nonce = randomUUID(),
} = {}) {
  validateIdentity(identity);
  validateBinding(binding);
  if (!Number.isSafeInteger(now) || !UUID.test(nonce))
    throw new TypeError('Invalid standalone receipt clock or nonce');
  const payload = {
    format: 'oge-vault-standalone-one-time-approval',
    version: 1, ...identity,
    binding, nonce, issuedAt: now, expiresAt: now + TEN_MINUTES,
  };
  const packed = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', secretKey(secret))
    .update(PREFIX).update(packed).digest('hex');
  return {
    ticket: packed + '.' + mac,
    nonceHash: digest(nonce),
    approvalHash: digest(binding),
    expiresAt: new Date(payload.expiresAt),
  };
}

export function verifyStandaloneRestoreTicket(ticket, identity, binding, {
  secret, now = Date.now(),
} = {}) {
  validateIdentity(identity);
  validateBinding(binding);
  if (typeof ticket !== 'string' || ticket.length > 4096 ||
      !/^[A-Za-z0-9_-]{60,3900}\.[a-f0-9]{64}$/.test(ticket))
    throw fail('vault-standalone-ticket-invalid-or-expired');
  const [packed, supplied] = ticket.split('.');
  const expected = createHmac('sha256', secretKey(secret))
    .update(PREFIX).update(packed).digest();
  if (!timingSafeEqual(expected, Buffer.from(supplied, 'hex')))
    throw fail('vault-standalone-ticket-invalid-or-expired');
  let payload;
  try {
    const bytes = Buffer.from(packed, 'base64url');
    if (bytes.toString('base64url') !== packed)
      throw new TypeError('Noncanonical ticket');
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true })
      .decode(bytes));
  } catch {
    throw fail('vault-standalone-ticket-invalid-or-expired');
  }
  if (!sameKeys(payload, [
    'format', 'version', 'ownerId', 'sessionVersion', 'repoId',
    'installationId', 'repoName', 'githubAccountId', 'githubLogin',
    'binding', 'nonce', 'issuedAt', 'expiresAt',
  ]) || payload.format !== 'oge-vault-standalone-one-time-approval' ||
      payload.version !== 1 ||
      !Number.isSafeInteger(now) ||
      !UUID.test(payload.nonce || '') ||
      !Number.isSafeInteger(payload.issuedAt) ||
      !Number.isSafeInteger(payload.expiresAt) ||
      payload.issuedAt > now + 5000 || payload.expiresAt <= now ||
      payload.expiresAt - payload.issuedAt !== TEN_MINUTES)
    throw fail('vault-standalone-ticket-invalid-or-expired');
  for (const key of Object.keys(identity)) {
    if (payload[key] !== identity[key])
      throw fail('vault-standalone-ticket-owner-or-repository-changed');
  }
  validateBinding(payload.binding);
  if (JSON.stringify(payload.binding) !== JSON.stringify(binding))
    throw fail('vault-standalone-ticket-selection-changed');
  return {
    nonceHash: digest(payload.nonce),
    approvalHash: digest(payload.binding),
    expiresAt: payload.expiresAt,
    kind: binding.kind, selectedCount: binding.selectedIds.length,
  };
}

function scope(identity) {
  return {
    ownerId: identity.ownerId,
    repoId: identity.repoId,
    installationId: identity.installationId,
    sessionVersion: identity.sessionVersion,
  };
}
function ledger(db) {
  return db.collection('vault_standalone_restore_approvals');
}

/** All stored fields are owner/repo scope, SHA256 hashes, timestamps and state. */
export async function recordStandaloneRestoreTicket(db, identity, issued, {
  now = new Date(),
} = {}) {
  validateIdentity(identity);
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      !HASH.test(issued?.nonceHash || '') ||
      !HASH.test(issued?.approvalHash || '') ||
      !(issued.expiresAt instanceof Date) ||
      issued.expiresAt <= now)
    throw new TypeError('Invalid signed standalone restore receipt');
  const owner = await db.collection('users').findOne({
    ...ownerMutationFilter(identity.ownerId, {
      sessionVersion: identity.sessionVersion,
    }),
    'vault.status': 'connected',
    'vault.repoId': identity.repoId,
    'vault.installationId': identity.installationId,
    'vault.repoName': identity.repoName,
    'vault.githubAccountId': identity.githubAccountId,
    'vault.githubLogin': identity.githubLogin,
    vaultImportLock: { $exists: false },
  }, { projection: { _id: 1 } });
  if (!owner)
    throw fail('vault-standalone-ticket-owner-or-repository-changed');

  const receipts = ledger(db);
  // Any claimed but not confirmed standalone restore could already have
  // committed remotely. Until an operator reviews it, issuance is blocked.
  // Checking only current session would permit re-login to bypass this.
  if (await receipts.findOne({
    ownerId: identity.ownerId, repoId: identity.repoId,
    installationId: identity.installationId, state: 'claimed',
  }, { projection: { _id: 1 } }))
    throw fail('vault-standalone-ticket-previous-batch-unconfirmed');
  await receipts.createIndex({ expiresAt: 1 }, {
    name: 'vault_standalone_restore_ticket_expiration_v1',
    expireAfterSeconds: 7 * 24 * 60 * 60,
  });
  await receipts.createIndex({
    ownerId: 1, repoId: 1, installationId: 1,
    sessionVersion: 1, createdAt: -1, _id: -1,
  }, { name: 'vault_standalone_restore_owner_batches_v1' });
  await receipts.insertOne({
    _id: issued.nonceHash, ...scope(identity),
    nonceHash: issued.nonceHash,
    approvalHash: issued.approvalHash,
    createdAt: now, expiresAt: issued.expiresAt,
    state: 'pending',
  });
  return { status: 'pending', expiresAt: issued.expiresAt };
}

/**
 * The caller MUST already own withVaultOwnerImportExclusive. One atomic
 * MongoDB pending->claimed CAS consumes the receipt before any GitHub
 * mutation; even a prewrite failure never authorizes another attempt.
 */
export async function claimStandaloneRestoreTicketOnce(db, identity, verified, {
  now = new Date(),
} = {}) {
  validateIdentity(identity);
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      !HASH.test(verified?.nonceHash || '') ||
      !HASH.test(verified?.approvalHash || ''))
    throw new TypeError('Invalid standalone restore claim');
  const row = await ledger(db).findOneAndUpdate({
    ...scope(identity),
    _id: verified.nonceHash, nonceHash: verified.nonceHash,
    approvalHash: verified.approvalHash,
    expiresAt: { $gt: now },
    state: 'pending',
  }, { $set: { state: 'claimed', claimedAt: now } },
  { returnDocument: 'after' });
  if (!row || row.state !== 'claimed')
    throw fail('vault-standalone-ticket-used-or-expired');
  return { claimed: true, autoRetryAllowed: false };
}

export async function confirmStandaloneRestoreTicket(
  db, identity, verified, commitSha, { now = new Date() } = {},
) {
  validateIdentity(identity);
  if (!SHA.test(commitSha || '') ||
      !(now instanceof Date) || !Number.isFinite(now.getTime()))
    throw new TypeError('Invalid confirmed standalone GitHub commit');
  const result = await ledger(db).updateOne({
    ...scope(identity),
    _id: verified.nonceHash,
    approvalHash: verified.approvalHash,
    state: 'claimed',
  }, { $set: {
    state: 'confirmed', confirmedAt: now, commitSha,
  } });
  if (result.matchedCount !== 1)
    throw fail('vault-standalone-ticket-confirmation-unconfirmed', 503);
  return { confirmed: true, commitSha, autoRetryAllowed: false };
}
