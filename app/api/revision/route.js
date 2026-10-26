import { auth } from '../../../auth.js';
import { getDatabase } from '../../../lib/mongodb.js';
import { ObjectId } from 'mongodb';
import { readLimitedBody } from '../../../lib/read-limited-body.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}
async function context() {
  const session = await auth();
  if (!session?.user?.id) return null;
  return { db: await getDatabase(), ownerId: session.user.id };
}
export async function GET() {
  try {
    const ctx = await context();
    if (!ctx) return json({ error: 'Sign in to start revision.' }, 401);
    const notes = await ctx.db.collection('notes').find(
      { ownerId: ctx.ownerId, $or: [{ reviewDueAt: { $exists: false } }, { reviewDueAt: { $lte: new Date() } }] },
      { projection: { _id: 1, heading: 1, answer: 1, subjectSlug: 1, tags: 1, reviewCount: 1, lastReviewedAt: 1 } },
    ).sort({ reviewDueAt: 1, createdAt: 1 }).limit(100).toArray();
    return json(notes.map((note) => ({ id: String(note._id), heading: note.heading, answer: note.answer, subjectSlug: note.subjectSlug, tags: note.tags || [], reviewCount: note.reviewCount || 0, lastReviewedAt: note.lastReviewedAt || null })));
  } catch (error) {
    console.error('GET /api/revision failed:', error?.name);
    return json({ error: 'Could not load revision cards.' }, 500);
  }
}
export async function POST(request) {
  const session = await auth();
  const ownerId = session?.user?.id;
  if (!ownerId) return json({ error: 'Sign in to record a revision.' }, 401);
  let data;
  try { data = JSON.parse(await readLimitedBody(request, 4 * 1024)); }
  catch (error) { return json({ error: error?.status === 413 ? 'Request body is too large.' : 'Enter valid JSON.' }, error?.status || 400); }
  const id = String(data?.id || '');
  const rating = String(data?.rating || '');
  const intervals = { again: 1, hard: 3, good: 7, easy: 14 };
  if (!ObjectId.isValid(id) || !Object.hasOwn(intervals, rating)) return json({ error: 'Choose a valid note and revision rating.' }, 400);
  try {
    const db = await getDatabase();
    const collection = db.collection('notes');
    const now = new Date();
    const nextReviewAt = new Date(now.getTime() + intervals[rating] * 24 * 60 * 60 * 1000);
    const result = await collection.findOneAndUpdate(
      { _id: new ObjectId(id), ownerId },
      { $set: { lastReviewedAt: now, lastReviewRating: rating, reviewDueAt: nextReviewAt }, $inc: { reviewCount: 1 } },
      { returnDocument: 'after', projection: { _id: 1, heading: 1, reviewDueAt: 1, reviewCount: 1 } },
    );
    if (!result) return json({ error: 'Note not found.' }, 404);
    return json({ id: String(result._id), heading: result.heading, reviewDueAt: result.reviewDueAt, reviewCount: result.reviewCount });
  } catch (error) {
    console.error('POST /api/revision failed:', error?.name);
    return json({ error: 'Could not save revision progress.' }, 500);
  }
}
