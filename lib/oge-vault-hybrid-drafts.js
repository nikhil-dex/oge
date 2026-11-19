import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// B5.3b: server-only encryption of temporary draft contents.
// Configure an independent 32-byte key as 64 hexadecimal characters.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[a-f0-9]{40}$/i;

export function draftKey(ownerId, repoId, noteId) {
  if (typeof ownerId !== 'string' || !ownerId || ownerId.length > 120 ||
      !Number.isSafeInteger(repoId) || repoId < 1 || !UUID.test(noteId || '')) {
    throw new TypeError('Invalid draft scope');
  }
  return { ownerId, repoId, noteId: noteId.toLowerCase() };
}

export function validatedHybridDraft(value) {
  if (!value || typeof value !== 'object' ||
      !UUID.test(value.subjectId || '') ||
      typeof value.heading !== 'string' || value.heading.length > 160 ||
      typeof value.answer !== 'string' || value.answer.length > 20000 ||
      !Array.isArray(value.tags) || value.tags.length > 10 ||
      value.tags.some((tag) => typeof tag !== 'string' || tag.length > 40) ||
      typeof value.favorite !== 'boolean' ||
      (value.baseSha !== null && !SHA.test(value.baseSha || ''))) {
    throw new TypeError('Invalid draft');
  }
  return { subjectId: value.subjectId.toLowerCase(), heading: value.heading,
    answer: value.answer, tags: [...value.tags], favorite: value.favorite,
    baseSha: value.baseSha };
}

function encryptionKey(hex = process.env.OGE_VAULT_DRAFT_KEY) {
  if (typeof hex !== 'string' || !/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error('Vault draft encryption key missing or invalid');
  }
  return Buffer.from(hex, 'hex');
}

export function sealDraft(draft, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(key), iv);
  const payload = Buffer.concat([cipher.update(JSON.stringify(validatedHybridDraft(draft))), cipher.final()]);
  return { version: 1, iv: iv.toString('base64'), ciphertext: payload.toString('base64'),
    tag: cipher.getAuthTag().toString('base64') };
}

export function unsealDraft(record, key) {
  if (record?.version !== 1) throw new TypeError('Unsupported draft encryption format');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(key), Buffer.from(record.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
  return validatedHybridDraft(JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, 'base64')), decipher.final(),
  ]).toString('utf8')));
}

/**
 * A new revision must be exactly previous + 1. Unique index on scope
 * prevents two initial writes; compare-and-swap prevents stale replacements.
 * The server must verify the signed session, repository and subject before calling.
 */
export async function putHybridDraft(collection, scope, revision, draft, { key } = {}) {
  const filter = draftKey(scope.ownerId, scope.repoId, scope.noteId);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new TypeError('Invalid revision');
  const encrypted = sealDraft(draft, key);
  const now = new Date();
  if (revision === 1) {
    await collection.insertOne({ ...filter, revision, encrypted, createdAt: now,
      updatedAt: now, status: 'pending', isNew: draft.baseSha === null });
    return { revision, status: 'pending' };
  }
  const result = await collection.updateOne({ ...filter, revision: revision - 1 },
    { $set: { revision, encrypted, updatedAt: now, status: 'pending', isNew: draft.baseSha === null } });
  if (result.matchedCount !== 1) throw new Error('vault-draft-revision-conflict');
  return { revision, status: 'pending' };
}

export async function getHybridDraft(collection, scope, { key } = {}) {
  const record = await collection.findOne(draftKey(scope.ownerId, scope.repoId, scope.noteId));
  if (!record) return null;
  return { revision: record.revision, status: record.status,
    draft: unsealDraft(record.encrypted, key) };
}

// Called ONLY after GitHub confirms the corresponding draft revision and content.
// A concurrent autosave revision remains untouched.
export async function clearConfirmedDraft(collection, scope, revision) {
  const filter = draftKey(scope.ownerId, scope.repoId, scope.noteId);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new TypeError('Invalid revision');
  const result = await collection.deleteOne({ ...filter, revision });
  return result.deletedCount === 1;
}
