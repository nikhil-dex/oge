import { randomUUID } from 'node:crypto';
import { auth } from '../../../auth.js';
import { getDatabase } from '../../../lib/mongodb.js';
import { readLimitedBody } from '../../../lib/read-limited-body.js';
import { normalizeSavedLink } from '../../../lib/saved-links.js';

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
  return { db: await getDatabase(), ownerId: session.user.id };
}

export async function GET() {
  try {
    const ctx = await context();
    if (!ctx) return json({ error: 'Sign in to view Saved Links.' }, 401);
    const links = await ctx.db.collection('savedLinks').find({ ownerId: ctx.ownerId }).sort({ order: 1, createdAt: -1 }).limit(500).toArray();
    return json(links.map(({ _id, title, url, description, category, tags, order, createdAt, updatedAt }) => ({ id: String(_id), title, url, description, category, tags: tags || [], order, createdAt, updatedAt })));
  } catch (error) {
    console.error('GET /api/saved-links failed:', error?.name);
    return json({ error: 'Could not load Saved Links.' }, 500);
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
    const collection = ctx.db.collection('savedLinks');
    const order = await collection.countDocuments({ ownerId: ctx.ownerId });
    const now = new Date();
    const link = { _id: randomUUID(), ownerId: ctx.ownerId, ...normalized.value, order, createdAt: now, updatedAt: now };
    await collection.insertOne(link);
    return json({ id: link._id, ...normalized.value, order, createdAt: now, updatedAt: now }, 201);
  } catch (error) {
    console.error('POST /api/saved-links failed:', error?.name);
    return json({ error: 'Could not save this link.' }, 500);
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
    const result = await ctx.db.collection('savedLinks').findOneAndUpdate(
      { _id: id, ownerId: ctx.ownerId },
      { $set: { ...normalized.value, updatedAt: new Date() } },
      { returnDocument: 'after', includeResultMetadata: false },
    );
    if (!result) return json({ error: 'Saved link not found.' }, 404);
    return json({ id: result._id, title: result.title, url: result.url, description: result.description, category: result.category, tags: result.tags || [], order: result.order, createdAt: result.createdAt, updatedAt: result.updatedAt });
  } catch (error) {
    console.error('PUT /api/saved-links failed:', error?.name);
    return json({ error: 'Could not update this link.' }, 500);
  }
}

export async function DELETE(request) {
  try {
    const ctx = await context();
    if (!ctx) return json({ error: 'Sign in to delete links.' }, 401);
    const id = new URL(request.url).searchParams.get('id') || '';
    if (!validId(id)) return json({ error: 'Choose a valid saved link.' }, 400);
    const collection = ctx.db.collection('savedLinks');
    const result = await collection.deleteOne({ _id: id, ownerId: ctx.ownerId });
    if (!result.deletedCount) return json({ error: 'Saved link not found.' }, 404);
    const remaining = await collection.find({ ownerId: ctx.ownerId }, { projection: { _id: 1, order: 1 } }).sort({ order: 1, createdAt: -1 }).toArray();
    if (remaining.length) await collection.bulkWrite(remaining.map((link, order) => ({ updateOne: { filter: { _id: link._id, ownerId: ctx.ownerId }, update: { $set: { order } } } })));
    return json({ deleted: id });
  } catch (error) {
    console.error('DELETE /api/saved-links failed:', error?.name);
    return json({ error: 'Could not delete this link.' }, 500);
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
    const collection = ctx.db.collection('savedLinks');
    const existingCount = await collection.countDocuments({ ownerId: ctx.ownerId, _id: { $in: ids } });
    if (existingCount !== ids.length) return json({ error: 'One or more links were not found.' }, 409);
    if (ids.length) await collection.bulkWrite(ids.map((id, order) => ({ updateOne: { filter: { _id: id, ownerId: ctx.ownerId }, update: { $set: { order, updatedAt: new Date() } } } })));
    return json({ reordered: ids.length });
  } catch (error) {
    console.error('PATCH /api/saved-links failed:', error?.name);
    return json({ error: 'Could not reorder links.' }, 500);
  }
}
