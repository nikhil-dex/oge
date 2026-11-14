import { auth } from '../../../auth.js';
import { getDatabase } from '../../../lib/mongodb.js';
import { checkOwnerMutationLimit, rateLimitResponse } from '../../../lib/rate-limit.js';
import { readLimitedBody } from '../../../lib/read-limited-body.js';
import { randomUUID } from 'node:crypto';
import { deleteSubjectAtomically } from '../../../lib/atomic-subject-deletion.js';
import { withActiveOwnerMutation } from '../../../lib/active-owner-mutation.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function GET() {
  const session = await auth();
  const ownerId = session?.user?.id;
  const sessionVersion = session?.user?.sessionVersion;
  if (!ownerId) return json({ error: 'Sign in to view your subjects.' }, 401);
  try {
    const db = await getDatabase();
    const subjects = await db.collection('subjects').find({ ownerId }).sort({ createdAt: 1 }).limit(1000).toArray();
    return json(subjects.map(({ _id, slug, name, createdAt }) => ({ id: String(_id), slug, name, createdAt })));
  } catch (error) {
    console.error('GET /api/subjects failed:', error?.name);
    return json({ error: 'Could not load subjects.' }, 500);
  }
}

export async function POST(request) {
  const session = await auth();
  const ownerId = session?.user?.id;
  const sessionVersion = session?.user?.sessionVersion;
  if (!ownerId) return json({ error: 'Sign in to create a subject.' }, 401);
  let data;
  try { data = JSON.parse(await readLimitedBody(request, 4 * 1024)); } catch (error) { return json({ error: error?.status === 413 ? 'Request body is too large.' : 'Enter valid JSON.' }, error?.status || 400); }
  const name = String(data?.name || '').trim().replace(/\s+/g, ' ');
  if (!name || name.length > 60) return json({ error: 'Subject name must be 1–60 characters.' }, 400);
  try {
    const db = await getDatabase();
    const throttle = await checkOwnerMutationLimit(db, ownerId, 'subjects');
    if (!throttle.allowed) return rateLimitResponse(throttle);
    return await withActiveOwnerMutation(db, ownerId, async (session) => {
      if (await db.collection('subjects').countDocuments({ ownerId }, { limit: 1000, session }) >= 1000) {
        return json({ error: 'Subject limit reached (1,000).' }, 409);
      }
      const subject = { ownerId, slug: randomUUID(), name, createdAt: new Date(), updatedAt: new Date() };
      await db.collection('subjects').insertOne(subject, { session });
      return json({ id: String(subject._id), slug: subject.slug, name: subject.name, createdAt: subject.createdAt }, 201);
    }, { sessionVersion: sessionVersion });
  } catch (error) {
    if (error?.code === 11000) return json({ error: 'That subject already exists.' }, 409);
    console.error('POST /api/subjects failed:', error?.name);
    return json({ error: 'Could not create the subject.' }, 500);
  }
}

export async function DELETE(request) {
  const session = await auth();
  const ownerId = session?.user?.id;
  const sessionVersion = session?.user?.sessionVersion;
  if (!ownerId) return json({ error: 'Sign in to delete a subject.' }, 401);
  const slug = new URL(request.url).searchParams.get('slug');
  if (!slug) return json({ error: 'Choose a subject.' }, 400);
  try {
    const db = await getDatabase();
    const throttle = await checkOwnerMutationLimit(db, ownerId, 'subjects');
    if (!throttle.allowed) return rateLimitResponse(throttle);
    const result = await deleteSubjectAtomically(db, ownerId, slug);
    if (result.status === 'not-found') return json({ error: 'Subject not found.' }, 404);
    if (result.status === 'last-subject') return json({ error: 'Keep at least one subject. Add another before deleting this one.' }, 400);
    return json({ deleted: slug });
  } catch (error) {
    console.error('DELETE /api/subjects failed:', error?.name);
    return json({ error: 'Could not delete the subject.' }, 500);
  }
}
