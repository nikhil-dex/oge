import { auth } from '../../../auth.js';
import { getDatabase } from '../../../lib/mongodb.js';
import { readLimitedBody } from '../../../lib/read-limited-body.js';
import { ObjectId } from 'mongodb';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function context() {
  const session = await auth();
  if (!session?.user?.id) return null;
  const db = await getDatabase();
  return { db, ownerId: session.user.id };
}

export async function GET(request) {
  try {
    const ctx = await context();
    if (!ctx) return json({ error: 'Sign in to view notes.' }, 401);
    const slug = new URL(request.url).searchParams.get('subject');
    const filter = { ownerId: ctx.ownerId };
    if (slug) filter.subjectSlug = slug;
    const notes = await ctx.db.collection('notes').find(filter).sort({ updatedAt: -1, createdAt: -1 }).limit(500).toArray();
    return json(notes.map((note) => ({
      id: String(note._id), subjectSlug: note.subjectSlug, heading: note.heading,
      answer: note.answer, tags: note.tags || [], favorite: Boolean(note.favorite),
      createdAt: note.createdAt, updatedAt: note.updatedAt,
    })));
  } catch (error) {
    console.error('GET /api/notes failed:', error?.name);
    return json({ error: 'Could not load notes.' }, 500);
  }
}

export async function POST(request) {
  try {
    const ctx = await context();
    if (!ctx) return json({ error: 'Sign in to create notes.' }, 401);
    let data;
    try { data = JSON.parse(await readLimitedBody(request, 32 * 1024)); } catch (error) { return json({ error: error?.status === 413 ? 'Request body is too large.' : 'Enter valid JSON.' }, error?.status || 400); }
    const subjectSlug = String(data?.subjectSlug || '');
    const heading = String(data?.heading || '').trim();
    const answer = String(data?.answer || '').trim();
    const tags = Array.isArray(data?.tags) ? [...new Set(data.tags.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean))].slice(0, 10) : [];
    if (!subjectSlug) return json({ error: 'Choose a subject.' }, 400);
    if (!heading || heading.length > 160) return json({ error: 'Heading must be 1–160 characters.' }, 400);
    if (!answer || answer.length > 20000) return json({ error: 'Note content must be 1–20,000 characters.' }, 400);
    const subject = await ctx.db.collection('subjects').findOne({ ownerId: ctx.ownerId, slug: subjectSlug });
    if (!subject) return json({ error: 'Subject not found.' }, 404);
    const now = new Date();
    const note = { ownerId: ctx.ownerId, subjectSlug, heading, answer, tags, favorite: false, createdAt: now, updatedAt: now, revisions: [] };
    await ctx.db.collection('notes').insertOne(note);
    return json({ id: String(note._id), subjectSlug, heading, answer, tags, favorite: false, createdAt: now, updatedAt: now }, 201);
  } catch (error) {
    console.error('POST /api/notes failed:', error?.name);
    return json({ error: 'Could not save this note.' }, 500);
  }
}

export async function PUT(request) {
  try {
    const ctx = await context();
    if (!ctx) return json({ error: 'Sign in to update notes.' }, 401);
    let data;
    try { data = JSON.parse(await readLimitedBody(request, 32 * 1024)); } catch (error) { return json({ error: error?.status === 413 ? 'Request body is too large.' : 'Enter valid JSON.' }, error?.status || 400); }
    const id = String(data?.id || '');
    const heading = String(data?.heading || '').trim();
    const answer = String(data?.answer || '').trim();
    const tags = Array.isArray(data?.tags) ? [...new Set(data.tags.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean))].slice(0, 10) : [];
    if (!ObjectId.isValid(id)) return json({ error: 'Choose a valid note.' }, 400);
    if (!heading || heading.length > 160 || !answer || answer.length > 20000) return json({ error: 'Add a heading and content within the allowed lengths.' }, 400);
    const collection = ctx.db.collection('notes');
    const previous = await collection.findOne({ _id: new ObjectId(id), ownerId: ctx.ownerId });
    if (!previous) return json({ error: 'Note not found.' }, 404);
    const now = new Date();
    const revisions = [...(Array.isArray(previous.revisions) ? previous.revisions : []), { heading: previous.heading, answer: previous.answer, savedAt: previous.updatedAt || previous.createdAt }].slice(-20);
    const result = await collection.findOneAndUpdate(
      { _id: new ObjectId(id), ownerId: ctx.ownerId },
      { $set: { heading, answer, tags, revisions, updatedAt: now } },
      { returnDocument: 'after', projection: { ownerId: 0 } },
    );
    if (!result) return json({ error: 'Note not found.' }, 404);
    return json({ id: String(result._id), subjectSlug: result.subjectSlug, heading: result.heading, answer: result.answer, tags: result.tags || [], favorite: Boolean(result.favorite), createdAt: result.createdAt, updatedAt: result.updatedAt });
  } catch (error) {
    console.error('PUT /api/notes failed:', error?.name);
    return json({ error: 'Could not update this note.' }, 500);
  }
}

export async function DELETE(request) {
  try {
    const ctx = await context();
    if (!ctx) return json({ error: 'Sign in to delete notes.' }, 401);
    const id = new URL(request.url).searchParams.get('id');
    if (!ObjectId.isValid(id || '')) return json({ error: 'Choose a valid note.' }, 400);
    const result = await ctx.db.collection('notes').deleteOne({ _id: new ObjectId(id), ownerId: ctx.ownerId });
    if (!result.deletedCount) return json({ error: 'Note not found.' }, 404);
    return json({ deleted: id });
  } catch (error) {
    console.error('DELETE /api/notes failed:', error?.name);
    return json({ error: 'Could not delete this note.' }, 500);
  }
}

export async function PATCH(request) {
  try {
    const ctx = await context();
    if (!ctx) return json({ error: 'Sign in to update notes.' }, 401);
    let data;
    try { data = JSON.parse(await readLimitedBody(request, 4 * 1024)); } catch (error) { return json({ error: error?.status === 413 ? 'Request body is too large.' : 'Enter valid JSON.' }, error?.status || 400); }
    const id = String(data?.id || '');
    if (!ObjectId.isValid(id) || typeof data?.favorite !== 'boolean') return json({ error: 'Choose a note and a valid favorite value.' }, 400);
    const result = await ctx.db.collection('notes').updateOne({ _id: new ObjectId(id), ownerId: ctx.ownerId }, { $set: { favorite: data.favorite, updatedAt: new Date() } });
    if (!result.matchedCount) return json({ error: 'Note not found.' }, 404);
    return json({ id, favorite: data.favorite });
  } catch (error) {
    console.error('PATCH /api/notes failed:', error?.name);
    return json({ error: 'Could not update this note.' }, 500);
  }
}
