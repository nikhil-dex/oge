import { auth } from '../../../auth.js';
import { getDatabase } from '../../../lib/mongodb.js';

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
    const history = notes.flatMap((note) => (Array.isArray(note.revisions) ? note.revisions : []).map((revision, index) => ({
      id: String(note._id) + ':' + index,
      noteId: String(note._id),
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
