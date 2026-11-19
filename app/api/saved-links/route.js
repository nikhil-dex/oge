import { randomUUID } from 'node:crypto';
import { withActiveOwnerMutation } from '../../../lib/active-owner-mutation.js';
import { auth } from '../../../auth.js';
import { getDatabase } from '../../../lib/mongodb.js';
import { checkOwnerMutationLimit, rateLimitResponse } from '../../../lib/rate-limit.js';
import { readLimitedBody } from '../../../lib/read-limited-body.js';
import { normalizeSavedLink } from '../../../lib/saved-links.js';
import { ownerMutationFilter } from '../../../lib/active-owner-mutation.js';
import { getVaultNoteClient } from '../../../lib/oge-vault-notes.js';
import { VaultGitHubError } from '../../../lib/oge-vault-github.js';
import {
  savedLinksStorageMode, readVaultSavedLinks, createVaultSavedLink,
  updateVaultSavedLink, deleteVaultSavedLink, reorderVaultSavedLinks,
} from '../../../lib/oge-vault-saved-links.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}
async function readJson(request, limit = 24 * 1024) {
  try { return { data: JSON.parse(await readLimitedBody(request, limit)) }; }
  catch (error) { return { error: json({ error: error?.status === 413 ? 'Request body is too large.' : 'Enter valid JSON.' }, error?.status || 400) }; }
}
function validId(value) { return typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value); }
async function context() {
  const session = await auth();
  if (!session?.user?.id) return null;
  const db = await getDatabase();
  const ownerId = session.user.id;
  const sessionVersion = session.user.sessionVersion;
  const account = await db.collection('users').findOne(
    ownerMutationFilter(ownerId, { sessionVersion }),
    { projection: { vault: 1, notesStorage: 1 } },
  );
  if (!account) throw new VaultGitHubError('session-expired', 401);
  const storage = savedLinksStorageMode(account);
  if (storage === 'choice-required') throw new VaultGitHubError('notes-storage-choice-required', 409);
  if (storage === 'vault-setup-required') throw new VaultGitHubError('vault-storage-setup-required', 409);
  return {
    db, ownerId, sessionVersion, storage,
    // Never use MongoDB as a fallback for GitHub-backed link content.
    ...(storage === 'github'
      ? { vaultClient: await getVaultNoteClient(db, { ownerId, sessionVersion }) }
      : {}),
  };
}

function storageError(error, operation) {
  if (error instanceof VaultGitHubError) {
    const status = [401, 404, 409, 429, 413].includes(error.status)
      ? error.status : 503;
    return json({ error: error.message }, status);
  }
  if (error instanceof TypeError) return json({ error: error.message }, 400);
  console.error(operation + ' /api/saved-links failed:', error?.name);
  return json({ error: 'Could not ' + operation.toLowerCase() +
    ' Saved Links. Existing links were not changed by MongoDB fallback.' }, 503);
}

export async function GET() {
  try {
    const ctx = await context();
    if (!ctx) return json({ error: 'Sign in to view Saved Links.' }, 401);
    if (ctx.storage === 'github')
      return json((await readVaultSavedLinks(ctx.vaultClient)).links);
    const links = await ctx.db.collection('savedLinks').find({ ownerId: ctx.ownerId }).sort({ order: 1, createdAt: -1 }).limit(500).toArray();
    return json(links.map(({ _id, title, url, description, category, tags, order, createdAt, updatedAt }) => ({ id: String(_id), title, url, description, category, tags: tags || [], order, createdAt, updatedAt })));
  } catch (error) {
    return storageError(error, 'Read');
  }
}

export async function POST(request) {
  const parsed = await readJson(request);
  if (parsed.error) return parsed.error;
  const normalized = normalizeSavedLink(parsed.data);
  if (normalized.error) return json({ error: normalized.error }, 400);
  try {
    const ctx = await context();
    if (!ctx) return json({ error: 'Sign in to save links.' }, 401);
    const throttle = await checkOwnerMutationLimit(ctx.db, ctx.ownerId, 'saved-links');
    if (!throttle.allowed) return rateLimitResponse(throttle);
    if (ctx.storage === 'github') return json(await createVaultSavedLink(
      ctx.vaultClient, normalized.value, { id: parsed.data?.id || randomUUID() },
    ), 201);
    return await withActiveOwnerMutation(ctx.db, ctx.ownerId, async (session) => {
      const collection = ctx.db.collection('savedLinks');
      const order = await collection.countDocuments({ ownerId: ctx.ownerId }, { session });
      const now = new Date();
      const link = { _id: randomUUID(), ownerId: ctx.ownerId, ...normalized.value, order, createdAt: now, updatedAt: now };
      await collection.insertOne(link, { session });
      return json({ id: link._id, ...normalized.value, order, createdAt: now, updatedAt: now }, 201);
    }, { sessionVersion: ctx.sessionVersion });
  } catch (error) {
    return storageError(error, 'Create');
  }
}

export async function PUT(request) {
  const parsed = await readJson(request);
  if (parsed.error) return parsed.error;
  const id = String(parsed.data?.id || '');
  if (!validId(id)) return json({ error: 'Choose a valid saved link.' }, 400);
  const normalized = normalizeSavedLink(parsed.data);
  if (normalized.error) return json({ error: normalized.error }, 400);
  try {
    const ctx = await context();
    if (!ctx) return json({ error: 'Sign in to edit links.' }, 401);
    const throttle = await checkOwnerMutationLimit(ctx.db, ctx.ownerId, 'saved-links');
    if (!throttle.allowed) return rateLimitResponse(throttle);
    if (ctx.storage === 'github') return json(await updateVaultSavedLink(
      ctx.vaultClient, id, normalized.value,
    ));
    return await withActiveOwnerMutation(ctx.db, ctx.ownerId, async (session) => {
      const result = await ctx.db.collection('savedLinks').findOneAndUpdate(
        { _id: id, ownerId: ctx.ownerId },
        { $set: { ...normalized.value, updatedAt: new Date() } },
        { returnDocument: 'after', includeResultMetadata: false, session },
      );
      if (!result) return json({ error: 'Saved link not found.' }, 404);
      return json({ id: result._id, title: result.title, url: result.url, description: result.description, category: result.category, tags: result.tags || [], order: result.order, createdAt: result.createdAt, updatedAt: result.updatedAt });
    }, { sessionVersion: ctx.sessionVersion });
  } catch (error) {
    return storageError(error, 'Update');
  }
}

export async function DELETE(request) {
  try {
    const ctx = await context();
    if (!ctx) return json({ error: 'Sign in to delete links.' }, 401);
    const throttle = await checkOwnerMutationLimit(ctx.db, ctx.ownerId, 'saved-links');
    if (!throttle.allowed) return rateLimitResponse(throttle);
    const id = new URL(request.url).searchParams.get('id') || '';
    if (!validId(id)) return json({ error: 'Choose a valid saved link.' }, 400);
    if (ctx.storage === 'github')
      return json(await deleteVaultSavedLink(ctx.vaultClient, id));
    return await withActiveOwnerMutation(ctx.db, ctx.ownerId, async (session) => {
      const collection = ctx.db.collection('savedLinks');
      const result = await collection.deleteOne({ _id: id, ownerId: ctx.ownerId }, { session });
      if (!result.deletedCount) return json({ error: 'Saved link not found.' }, 404);
      const remaining = await collection.find({ ownerId: ctx.ownerId }, { session, projection: { _id: 1, order: 1 } }).sort({ order: 1, createdAt: -1 }).toArray();
      if (remaining.length) await collection.bulkWrite(
        remaining.map((link, order) => ({ updateOne: { filter: { _id: link._id, ownerId: ctx.ownerId }, update: { $set: { order } } } })),
        { session },
      );
      return json({ deleted: id });
    }, { sessionVersion: ctx.sessionVersion });
  } catch (error) {
    return storageError(error, 'Delete');
  }
}

export async function PATCH(request) {
  const parsed = await readJson(request, 32 * 1024);
  if (parsed.error) return parsed.error;
  const ids = parsed.data?.orderedIds;
  if (!Array.isArray(ids) || ids.length > 500 || ids.some((id) => !validId(id)) || new Set(ids).size !== ids.length) return json({ error: 'Choose a valid order for the saved links.' }, 400);
  try {
    const ctx = await context();
    if (!ctx) return json({ error: 'Sign in to reorder links.' }, 401);
    const throttle = await checkOwnerMutationLimit(ctx.db, ctx.ownerId, 'saved-links');
    if (!throttle.allowed) return rateLimitResponse(throttle);
    if (ctx.storage === 'github') return json(await reorderVaultSavedLinks(
      ctx.vaultClient, ids,
    ));
    return await withActiveOwnerMutation(ctx.db, ctx.ownerId, async (session) => {
      const collection = ctx.db.collection('savedLinks');
      const existingCount = await collection.countDocuments({ ownerId: ctx.ownerId, _id: { $in: ids } }, { session });
      if (existingCount !== ids.length) return json({ error: 'One or more links were not found.' }, 409);
      if (ids.length) await collection.bulkWrite(
        ids.map((id, order) => ({ updateOne: { filter: { _id: id, ownerId: ctx.ownerId }, update: { $set: { order, updatedAt: new Date() } } } })),
        { session },
      );
      return json({ reordered: ids.length });
    }, { sessionVersion: ctx.sessionVersion });
  } catch (error) {
    return storageError(error, 'Reorder');
  }
}
