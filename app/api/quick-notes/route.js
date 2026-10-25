import { randomUUID } from 'node:crypto';
import { auth } from '../../../auth.js';
import { getDatabase } from '../../../lib/mongodb.js';
import { readLimitedBody } from '../../../lib/read-limited-body.js';
import { MAX_QUICK_NOTE_LENGTH, normalizeQuickNoteContent, quickNoteTitle } from '../../../lib/quick-notes.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}
async function readJson(request) {
  try { return { data: JSON.parse(await readLimitedBody(request, 32 * 1024)) }; }
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
    if (!ctx) return json({ error: 'Sign in to view Quick Notes.' }, 401);
    const notes = await ctx.db.collection('quickNotes').find({ ownerId: ctx.ownerId }).sort({ updatedAt: -1 }).limit(300).toArray();
    return json(notes.map(({ _id, content, title, createdAt, updatedAt }) => ({ id: String(_id), content, title, createdAt, updatedAt })));
  } catch (error) {
    console.error('GET /api/quick-notes failed:', error?.name);
    return json({ error: 'Could not load Quick Notes.' }, 500);
  }
}

export async function POST(request) {
  const parsed = await readJson(request);
  if (parsed.error) return parsed.error;
  if (typeof parsed.data?.content !== 'string') return json({ error: 'Quick note content must be text.' }, 400);
  const content = normalizeQuickNoteContent(parsed.data.content);
  if (content.length > MAX_QUICK_NOTE_LENGTH) return json({ error: 'Quick notes must be 20,000 characters or fewer.' }, 400);
  try {
    const ctx = await context();
    if (!ctx) return json({ error: 'Sign in to create Quick Notes.' }, 401);
    const now = new Date();
    const note = { _id: randomUUID(), ownerId: ctx.ownerId, content, title: quickNoteTitle(content), createdAt: now, updatedAt: now };
    await ctx.db.collection('quickNotes').insertOne(note);
    return json({ id: note._id, content, title: note.title, createdAt: now, updatedAt: now }, 201);
  } catch (error) {
    console.error('POST /api/quick-notes failed:', error?.name);
    return json({ error: 'Could not create this Quick Note.' }, 500);
  }
}

export async function PUT(request) {
  const parsed = await readJson(request);
  if (parsed.error) return parsed.error;
  const id = parsed.data?.id;
  if (!validId(id) || typeof parsed.data?.content !== 'string') return json({ error: 'Choose a valid note and provide text content.' }, 400);
  const content = normalizeQuickNoteContent(parsed.data.content);
  if (content.length > MAX_QUICK_NOTE_LENGTH) return json({ error: 'Quick notes must be 20,000 characters or fewer.' }, 400);
  try {
    const ctx = await context();
    if (!ctx) return json({ error: 'Sign in to update Quick Notes.' }, 401);
    const now = new Date();
    const result = await ctx.db.collection('quickNotes').findOneAndUpdate(
      { _id: id, ownerId: ctx.ownerId },
      { $set: { content, title: quickNoteTitle(content), updatedAt: now } },
      { returnDocument: 'after', includeResultMetadata: false },
    );
    if (!result) return json({ error: 'Quick Note not found.' }, 404);
    return json({ id: String(result._id), content: result.content, title: result.title, createdAt: result.createdAt, updatedAt: result.updatedAt });
  } catch (error) {
    console.error('PUT /api/quick-notes failed:', error?.name);
    return json({ error: 'Could not save this Quick Note.' }, 500);
  }
}

export async function DELETE(request) {
  try {
    const ctx = await context();
    if (!ctx) return json({ error: 'Sign in to delete Quick Notes.' }, 401);
    const id = new URL(request.url).searchParams.get('id') || '';
    if (!validId(id)) return json({ error: 'Choose a valid Quick Note.' }, 400);
    const result = await ctx.db.collection('quickNotes').deleteOne({ _id: id, ownerId: ctx.ownerId });
    if (!result.deletedCount) return json({ error: 'Quick Note not found.' }, 404);
    return json({ deleted: id });
  } catch (error) {
    console.error('DELETE /api/quick-notes failed:', error?.name);
    return json({ error: 'Could not delete this Quick Note.' }, 500);
  }
}
