import { auth } from '../../../auth.js';
import { getDatabase } from '../../../lib/mongodb.js';
import { randomUUID } from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function GET() {
  const session = await auth();
  const ownerId = session?.user?.id;
  if (!ownerId) return json({ error: 'Sign in to view your subjects.' }, 401);
  try {
    const db = await getDatabase();
    const subjects = await db.collection('subjects').find({ ownerId }).sort({ createdAt: 1 }).toArray();
    return json(subjects.map(({ _id, slug, name, createdAt }) => ({ id: String(_id), slug, name, createdAt })));
  } catch (error) {
    console.error('GET /api/subjects failed:', error?.name);
    return json({ error: 'Could not load subjects.' }, 500);
  }
}

export async function POST(request) {
  const session = await auth();
  const ownerId = session?.user?.id;
  if (!ownerId) return json({ error: 'Sign in to create a subject.' }, 401);
  let data;
  try { data = await request.json(); } catch { return json({ error: 'Enter valid JSON.' }, 400); }
  const name = String(data?.name || '').trim().replace(/\s+/g, ' ');
  if (!name || name.length > 60) return json({ error: 'Subject name must be 1–60 characters.' }, 400);
  try {
    const db = await getDatabase();
    const subject = { ownerId, slug: randomUUID(), name, createdAt: new Date(), updatedAt: new Date() };
    await db.collection('subjects').insertOne(subject);
    return json({ id: String(subject._id), slug: subject.slug, name: subject.name, createdAt: subject.createdAt }, 201);
  } catch (error) {
    if (error?.code === 11000) return json({ error: 'That subject already exists.' }, 409);
    console.error('POST /api/subjects failed:', error?.name);
    return json({ error: 'Could not create the subject.' }, 500);
  }
}

export async function DELETE(request) {
  const session = await auth();
  const ownerId = session?.user?.id;
  if (!ownerId) return json({ error: 'Sign in to delete a subject.' }, 401);
  const slug = new URL(request.url).searchParams.get('slug');
  if (!slug) return json({ error: 'Choose a subject.' }, 400);
  try {
    const db = await getDatabase();
    const subject = await db.collection('subjects').findOne({ ownerId, slug });
    if (!subject) return json({ error: 'Subject not found.' }, 404);
    const count = await db.collection('subjects').countDocuments({ ownerId });
    if (count <= 1) return json({ error: 'Keep at least one subject. Add another before deleting this one.' }, 400);
    await db.collection('notes').deleteMany({ ownerId, subjectSlug: slug });
    await db.collection('subjects').deleteOne({ _id: subject._id, ownerId });
    return json({ deleted: slug });
  } catch (error) {
    console.error('DELETE /api/subjects failed:', error?.name);
    return json({ error: 'Could not delete the subject.' }, 500);
  }
}
