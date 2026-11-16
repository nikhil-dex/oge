import {
  createCipheriv, createDecipheriv, hkdfSync, randomBytes,
} from 'node:crypto';
import { validatedStandaloneCapture, getVaultStandaloneCapture } from './oge-vault-standalone-captures.js';
import { VaultGitHubError } from './oge-vault-github.js';

/**
 * E3 / M71: TEMPORARY encrypted draft records for GitHub standalone captures.
 * The confirmed permanent contents are ALWAYS in the private GitHub Vault,
 * not the vault_standalone_drafts MongoDB collection.
 *
 * AAD binds owner/repository/kind/UUID/revision so ciphertext from a
 * different note, account, device or revision cannot be substituted.
 * This module is server-only; never import it into React/client bundles.
 */
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{40}$/;
const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_CIPHERTEXT = 32 * 1024;
const KINDS = new Set(['quick-notes', 'airnotes']);
const fail = () => { throw new TypeError('Invalid or compromised standalone Vault draft'); };
const exactKeys = (object, names) => object && typeof object === 'object' &&
  !Array.isArray(object) && Object.keys(object).sort().join(',') ===
  [...names].sort().join(',');

export function standaloneDraftScope(ownerId, repoId, kind, captureId) {
  if (typeof ownerId !== 'string' || !ownerId || ownerId.length > 120 ||
      !Number.isSafeInteger(repoId) || repoId < 1 ||
      !KINDS.has(kind) || typeof captureId !== 'string' ||
      !UUID.test(captureId)) fail();
  return { ownerId, repoId, kind, captureId: captureId.toLowerCase() };
}

export function validatedStandaloneDraft(kind, draft, captureId) {
  if (!exactKeys(draft, ['content', 'baseSha']) ||
      typeof draft.content !== 'string' ||
      (draft.baseSha !== null && (typeof draft.baseSha !== 'string' ||
        !SHA.test(draft.baseSha)))) fail();
  const checked = validatedStandaloneCapture(kind, {
    content: draft.content,
  }, { id: captureId });
  return { content: checked.content, baseSha: draft.baseSha };
}

function deriveKey(keyHex = process.env.OGE_VAULT_DRAFT_KEY) {
  if (typeof keyHex !== 'string' || !/^[a-f0-9]{64}$/i.test(keyHex)) fail();
  const root = Buffer.from(keyHex, 'hex');
  try {
    // Independent domain from subject-linked hybrid drafts: never use its
    // original undifferentiated AES key for this collection.
    return Buffer.from(hkdfSync('sha256', root,
      Buffer.from('oge-vault-standalone-draft-salt-v1'),
      Buffer.from('oge-vault-standalone-draft-aead-v1'), 32));
  } finally { root.fill(0); }
}
function aad(scope, revision) {
  if (!Number.isSafeInteger(revision) || revision < 1) fail();
  const id = standaloneDraftScope(
    scope?.ownerId, scope?.repoId, scope?.kind, scope?.captureId);
  return Buffer.from(JSON.stringify([
    'oge-vault-standalone-draft', 1, id.ownerId, id.repoId,
    id.kind, id.captureId, revision,
  ]), 'utf8');
}
function decodeB64(value, length = null) {
  if (typeof value !== 'string' || !B64.test(value) ||
      value.length > 48 * 1024) fail();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value ||
      (length !== null && bytes.length !== length)) fail();
  return bytes;
}

export function sealStandaloneDraft(scope, revision, draft, {
  key, iv = randomBytes(12),
} = {}) {
  const id = standaloneDraftScope(
    scope?.ownerId, scope?.repoId, scope?.kind, scope?.captureId);
  const verified = validatedStandaloneDraft(id.kind, draft, id.captureId);
  if (!Buffer.isBuffer(iv) || iv.length !== 12) fail();
  const material = deriveKey(key);
  let plaintext;
  try {
    plaintext = Buffer.from(JSON.stringify(verified), 'utf8');
    if (plaintext.length > MAX_CIPHERTEXT) fail();
    const encrypt = createCipheriv('aes-256-gcm', material, iv);
    encrypt.setAAD(aad(id, revision));
    const ciphertext = Buffer.concat([encrypt.update(plaintext), encrypt.final()]);
    return {
      version: 1, iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      tag: encrypt.getAuthTag().toString('base64'),
    };
  } finally { material.fill(0); plaintext?.fill(0); }
}

export function openStandaloneDraft(scope, revision, record, { key } = {}) {
  if (!exactKeys(record, ['version', 'iv', 'ciphertext', 'tag']) ||
      record.version !== 1) fail();
  const iv = decodeB64(record.iv, 12);
  const tag = decodeB64(record.tag, 16);
  const encrypted = decodeB64(record.ciphertext);
  if (encrypted.length > MAX_CIPHERTEXT) fail();
  const material = deriveKey(key);
  let plaintext;
  try {
    const decrypt = createDecipheriv('aes-256-gcm', material, iv);
    decrypt.setAAD(aad(scope, revision));
    decrypt.setAuthTag(tag);
    plaintext = Buffer.concat([decrypt.update(encrypted), decrypt.final()]);
    if (plaintext.length > MAX_CIPHERTEXT) fail();
    const draft = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
    if (!exactKeys(draft, ['content', 'baseSha'])) fail();
    const verified = validatedStandaloneDraft(scope.kind, draft, scope.captureId);
    if (JSON.stringify(verified) !== JSON.stringify(draft)) fail();
    return verified;
  } catch { fail(); }
  finally { material.fill(0); plaintext?.fill(0); encrypted.fill(0); }
}

export async function readStandaloneDraft(collection, scope, { key } = {}) {
  const id = standaloneDraftScope(
    scope?.ownerId, scope?.repoId, scope?.kind, scope?.captureId);
  const found = await collection.findOne(id);
  if (!found) return null;
  const draft = openStandaloneDraft(id, found.revision, found.encrypted, { key });
  if (found.isNew !== (draft.baseSha === null) ||
      found.status !== 'pending') fail();
  return {
    id: id.captureId, kind: id.kind, revision: found.revision,
    status: found.status, draft,
  };
}

export async function putStandaloneDraft(collection, scope, revision, draft, {
  key,
} = {}) {
  const id = standaloneDraftScope(
    scope?.ownerId, scope?.repoId, scope?.kind, scope?.captureId);
  if (!Number.isSafeInteger(revision) || revision < 1) fail();
  const checked = validatedStandaloneDraft(id.kind, draft, id.captureId);
  // Read before UPDATE to prevent changing baseSha between autosaves.
  // A concurrent newer write is rejected by the revision CAS below.
  if (revision > 1) {
    const current = await readStandaloneDraft(collection, id, { key });
    if (!current || current.revision !== revision - 1 ||
        current.draft.baseSha !== checked.baseSha)
      throw new VaultGitHubError('vault-standalone-draft-revision-conflict', 409);
  }
  const encrypted = sealStandaloneDraft(id, revision, checked, { key });
  const now = new Date();
  if (revision === 1) {
    try {
      await collection.insertOne({
        ...id, revision, encrypted, isNew: checked.baseSha === null,
        status: 'pending', createdAt: now, updatedAt: now,
      });
    } catch (error) {
      if (error?.code === 11000)
        throw new VaultGitHubError('vault-standalone-draft-revision-conflict', 409);
      throw error;
    }
  } else {
    const result = await collection.updateOne({
      ...id, revision: revision - 1,
    }, { $set: {
      revision, encrypted, isNew: checked.baseSha === null,
      status: 'pending', updatedAt: now,
    } });
    if (result.matchedCount !== 1)
      throw new VaultGitHubError('vault-standalone-draft-revision-conflict', 409);
  }
  return { kind: id.kind, id: id.captureId, revision,
    status: 'pending', savedTo: 'temporary-encrypted-draft',
    committedToGitHub: false };
}

/**
 * ONLY read-only, current-GitHub-content verification can clear this exact
 * temporary revision. No GitHub writes, note content copying, or auto retry.
 *
 * A matching SHA and content prove current state, NOT who performed a remote
 * write, and NOT a full, independently signed provider acceptance.
 */
export async function reconcileStandaloneDraft(collection, client, scope,
  revision, expectedSha, { key, reader = getVaultStandaloneCapture } = {}) {
  const id = standaloneDraftScope(
    scope?.ownerId, scope?.repoId, scope?.kind, scope?.captureId);
  if (!Number.isSafeInteger(revision) || revision < 1 ||
      typeof expectedSha !== 'string' || !SHA.test(expectedSha)) fail();
  if (client?.vault?.repoId !== id.repoId || client?.readOnly !== true)
    throw new VaultGitHubError('vault-standalone-draft-client-scope-mismatch', 409);
  // Capture the precise ciphertext BEFORE the GitHub read. A second
  // device can CAS-update this same revision during remote verification;
  // the final delete MUST match this exact captured ciphertext, not a
  // newly fetched one (otherwise a newer draft could be destroyed).
  const snapshot = await collection.findOne(id);
  if (!snapshot || snapshot.revision !== revision)
    return { confirmed: false, cleared: false, reason: 'draft-missing-or-newer' };
  const draft = openStandaloneDraft(id, revision, snapshot.encrypted, { key });
  let saved;
  try { saved = await reader(client, id.kind, id.captureId); }
  catch {
    return { confirmed: false, cleared: false, reason: 'github-content-unavailable' };
  }
  if (saved?.id !== id.captureId || saved?.sha !== expectedSha ||
      saved?.content !== draft.content ||
      (draft.baseSha !== null && saved.sha === draft.baseSha))
    return { confirmed: false, cleared: false, reason: 'github-content-not-confirmed' };
  // Race-safe: never delete a newer autosave. Any failed CAS keeps draft.
  const result = await collection.deleteOne({
    ...id, revision, 'encrypted.ciphertext': snapshot.encrypted.ciphertext,
  });
  if (result.deletedCount !== 1)
    return { confirmed: true, cleared: false, reason: 'newer-draft-present' };
  return { confirmed: true, cleared: true, revision,
    kind: id.kind, id: id.captureId, sha: saved.sha,
    authority: 'current-github-content-only',
    safeToRetryGitHubWrite: false };
}
