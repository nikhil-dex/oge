import { auth } from '../../../auth.js';
import { getDatabase } from '../../../lib/mongodb.js';
import { ObjectId } from 'mongodb';
import { readLimitedBody } from '../../../lib/read-limited-body.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function GET() {
  try {
    const session = await auth();
    const ownerId = session?.user?.id;
    if (!ownerId) return json({ error: 'Sign in to view revision history.' }, 401);
    const db = await getDatabase();
    const notes = await db.collection('notes').find(
      { ownerId, revisions: { $exists: true, $ne: [] } },
      { projection: { _id: 1, subjectSlug: 1, heading: 1, revisions: 1, updatedAt: 1 } },
    ).sort({ updatedAt: -1 }).limit(100).toArray();
    const history = notes.flatMap((note) => (Array.isArray(note.revisions) ? note.revisions : []).map((revision, revisionIndex) => ({
      id: String(note._id) + ':' + revisionIndex,
      noteId: String(note._id),
      revisionIndex,
      subjectSlug: note.subjectSlug,
      currentHeading: note.heading,
      previousHeading: revision.heading || 'Untitled note',
      previousAnswer: revision.answer || '',
      savedAt: revision.savedAt || null,
      revisedAt: revision.revisedAt || null,
    })));
    history.sort((a, b) => new Date(b.revisedAt || b.savedAt || 0).getTime() - new Date(a.revisedAt || a.savedAt || 0).getTime());
    return json(history.slice(0, 200));
  } catch (error) {
    console.error('GET /api/revision-history failed:', error?.name);
    return json({ error: 'Could not load revision history.' }, 500);
  }
}

export async function POST(request) {
  const session = await auth();
  const ownerId = session?.user?.id;
  if (!ownerId) return json({ error: 'Sign in to restore a previous version.' }, 401);
  let data;
  try { data = JSON.parse(await readLimitedBody(request, 4 * 1024)); }
  catch (error) { return json({ error: error?.status === 413 ? 'Request body is too large.' : 'Enter valid JSON.' }, error?.status || 400); }

  const noteId = String(data?.noteId || '');
  const revisionIndex = data?.revisionIndex;
  if (!ObjectId.isValid(noteId) || !Number.isInteger(revisionIndex) || revisionIndex < 0 || revisionIndex > 19) {
    return json({ error: 'Choose a valid saved version.' }, 400);
  }

  try {
    const db = await getDatabase();
    const collection = db.collection('notes');
    const note = await collection.findOne({ _id: new ObjectId(noteId), ownerId });
    if (!note) return json({ error: 'Note not found.' }, 404);
    const revisions = Array.isArray(note.revisions) ? note.revisions : [];
    const chosen = revisions[revisionIndex];
    if (!chosen || typeof chosen.heading !== 'string' || typeof chosen.answer !== 'string') {
      return json({ error: 'That saved version is no longer available. Refresh the history and try again.' }, 409);
    }

    const now = new Date();
    const updatedRevisions = [...revisions, {
      heading: note.heading,
      answer: note.answer,
      savedAt: note.updatedAt || note.createdAt || now,
    }].slice(-20);
    const restoreFilter = { _id: new ObjectId(noteId), ownerId };
    if (note.updatedAt !== undefined) restoreFilter.updatedAt = note.updatedAt;
    else restoreFilter.updatedAt = { $exists: false };
    const result = await collection.findOneAndUpdate(
      restoreFilter,
      { $set: {
        heading: chosen.heading,
        answer: chosen.answer,
        revisions: updatedRevisions,
        updatedAt: now,
      } },
      { returnDocument: 'after', projection: { _id: 1, subjectSlug: 1, heading: 1, answer: 1, updatedAt: 1 } },
    );
    if (!result) return json({ error: 'This note changed while you were restoring. Refresh history and try again.' }, 409);
    return json({
      id: String(result._id),
      subjectSlug: result.subjectSlug,
      heading: result.heading,
      answer: result.answer,
      updatedAt: result.updatedAt,
      message: 'Previous version restored. The content that was current has been saved in revision history.',
    });
  } catch (error) {
    console.error('POST /api/revision-history failed:', error?.name);
    return json({ error: 'Could not restore this version.' }, 500);
  }
}
