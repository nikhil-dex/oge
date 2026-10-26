import { randomUUID } from 'node:crypto';
import { auth } from '../../../auth.js';
import { getDatabase } from '../../../lib/mongodb.js';
import { readLimitedBody } from '../../../lib/read-limited-body.js';
import { normalizeSavedLink } from '../../../lib/saved-links.js';
import { MAX_QUICK_NOTE_LENGTH, normalizeQuickNoteContent, quickNoteTitle } from '../../../lib/quick-notes.js';
import { NEWS_TOPICS } from '../../../lib/news-topics.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const MAX_BACKUP_BYTES = 10 * 1024 * 1024;

function json(data, status = 200, headers = {}) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store, max-age=0', ...headers } });
}
async function context() {
  const session = await auth();
  if (!session?.user?.id) return null;
  return { db: await getDatabase(), ownerId: session.user.id };
}
function publicSubject(item) { return { slug: item.slug, name: item.name, createdAt: item.createdAt }; }
function publicNote(item) {
  return { id: String(item._id), subjectSlug: item.subjectSlug, heading: item.heading, answer: item.answer, tags: Array.isArray(item.tags) ? item.tags : [], favorite: Boolean(item.favorite), createdAt: item.createdAt, updatedAt: item.updatedAt };
}
function publicLink(item) {
  return { id: String(item._id), title: item.title, url: item.url, description: item.description || '', category: item.category || '', tags: Array.isArray(item.tags) ? item.tags : [], order: item.order || 0, createdAt: item.createdAt, updatedAt: item.updatedAt };
}
function publicQuickNote(item) {
  return { id: String(item._id), content: item.content || '', title: item.title || quickNoteTitle(item.content || ''), createdAt: item.createdAt, updatedAt: item.updatedAt };
}

export async function GET() {
  try {
    const ctx = await context();
    if (!ctx) return json({ error: 'Sign in to export your OgeNotes data.' }, 401);
    const [user, subjects, notes, savedLinks, quickNotes] = await Promise.all([
      ctx.db.collection('users').findOne({ googleSub: ctx.ownerId }, { projection: { newsInterests: 1 } }),
      ctx.db.collection('subjects').find({ ownerId: ctx.ownerId }).sort({ createdAt: 1 }).toArray(),
      ctx.db.collection('notes').find({ ownerId: ctx.ownerId }).sort({ createdAt: 1 }).toArray(),
      ctx.db.collection('savedLinks').find({ ownerId: ctx.ownerId }).sort({ order: 1, createdAt: -1 }).toArray(),
      ctx.db.collection('quickNotes').find({ ownerId: ctx.ownerId }).sort({ updatedAt: -1 }).toArray(),
    ]);
    const backup = {
      format: 'oge-notes-backup', version: 1, exportedAt: new Date().toISOString(),
      preferences: { newsInterests: Array.isArray(user?.newsInterests) ? user.newsInterests : [] },
      subjects: subjects.map(publicSubject), notes: notes.map(publicNote),
      savedLinks: savedLinks.map(publicLink), quickNotes: quickNotes.map(publicQuickNote),
    };
    const filename = 'oge-notes-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    return new Response(JSON.stringify(backup, null, 2), { status: 200, headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="' + filename + '"',
      'Cache-Control': 'private, no-store, max-age=0', 'X-Content-Type-Options': 'nosniff',
    } });
  } catch (error) {
    console.error('GET /api/backup failed:', error?.name);
    return json({ error: 'Could not export your backup.' }, 500);
  }
}

export async function POST(request) {
  const ctx = await context();
  if (!ctx) return json({ error: 'Sign in to restore your OgeNotes data.' }, 401);
  let raw;
  try { raw = await readLimitedBody(request, MAX_BACKUP_BYTES); }
  catch (error) { return json({ error: error?.status === 413 ? 'Backup files must be 10 MB or smaller.' : 'Could not read the backup file.' }, error?.status || 400); }
  let backup;
  try { backup = JSON.parse(raw); } catch { return json({ error: 'The selected file is not valid JSON.' }, 400); }
  if (!backup || backup.format !== 'oge-notes-backup' || backup.version !== 1) return json({ error: 'This is not a supported OgeNotes backup file.' }, 400);
  const arrays = ['subjects', 'notes', 'savedLinks', 'quickNotes'];
  if (arrays.some((key) => !Array.isArray(backup[key]) || backup[key].length > 5000)) return json({ error: 'The backup structure is invalid or contains too many records.' }, 400);
  if (backup.subjects.some((item) => !item || typeof item.name !== 'string' || !item.name.trim() || item.name.trim().length > 60 || typeof item.slug !== 'string' || !item.slug)) return json({ error: 'One or more backup subjects are invalid.' }, 400);
  if (backup.notes.some((item) => !item || typeof item.subjectSlug !== 'string' || typeof item.heading !== 'string' || !item.heading.trim() || item.heading.length > 160 || typeof item.answer !== 'string' || !item.answer.trim() || item.answer.length > 20000)) return json({ error: 'One or more backup notes are invalid.' }, 400);
  if (backup.quickNotes.some((item) => !item || typeof item.content !== 'string' || item.content.length > MAX_QUICK_NOTE_LENGTH)) return json({ error: 'One or more Quick Notes are invalid.' }, 400);
  const normalizedLinks = backup.savedLinks.map((item) => normalizeSavedLink(item));
  if (normalizedLinks.some((item) => item.error)) return json({ error: 'One or more Saved Links are invalid. Export a fresh backup and try again.' }, 400);
  const submittedInterests = backup.preferences?.newsInterests ?? [];
  if (!Array.isArray(submittedInterests) || submittedInterests.some((item) => typeof item !== 'string' || !NEWS_TOPICS.includes(item))) return json({ error: 'Backup news preferences are invalid.' }, 400);

  try {
    const { db, ownerId } = ctx;
    const subjectCollection = db.collection('subjects');
    const noteCollection = db.collection('notes');
    const linkCollection = db.collection('savedLinks');
    const quickCollection = db.collection('quickNotes');
    const existingSubjects = await subjectCollection.find({ ownerId }).toArray();
    const subjectByName = new Map(existingSubjects.map((subject) => [subject.name.trim().toLocaleLowerCase(), subject]));
    const slugMap = new Map();
    let subjectsAdded = 0;
    let skipped = 0;

    for (const source of backup.subjects) {
      if (slugMap.has(source.slug)) continue;
      const normalizedName = source.name.trim().replace(/\s+/g, ' ');
      const existing = subjectByName.get(normalizedName.toLocaleLowerCase());
      if (existing) { slugMap.set(source.slug, existing.slug); skipped += 1; continue; }
      const created = { ownerId, slug: randomUUID(), name: normalizedName, createdAt: new Date(), updatedAt: new Date() };
      try {
        await subjectCollection.insertOne(created);
        subjectByName.set(created.name.toLocaleLowerCase(), created);
        slugMap.set(source.slug, created.slug);
        subjectsAdded += 1;
      } catch (error) {
        if (error?.code !== 11000) throw error;
        const duplicate = await subjectCollection.findOne({ ownerId, name: created.name });
        if (!duplicate) throw error;
        slugMap.set(source.slug, duplicate.slug);
        skipped += 1;
      }
    }

    let notesAdded = 0;
    for (const source of backup.notes) {
      const subjectSlug = slugMap.get(source.subjectSlug);
      if (!subjectSlug) { skipped += 1; continue; }
      const heading = source.heading.trim();
      const answer = source.answer.trim();
      const exists = await noteCollection.findOne({ ownerId, subjectSlug, heading, answer }, { projection: { _id: 1 } });
      if (exists) { skipped += 1; continue; }
      await noteCollection.insertOne({
        ownerId, subjectSlug, heading, answer,
        tags: Array.isArray(source.tags) ? [...new Set(source.tags.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean))].slice(0, 10) : [],
        favorite: Boolean(source.favorite), createdAt: new Date(), updatedAt: new Date(), revisions: [],
      });
      notesAdded += 1;
    }

    let savedLinksAdded = 0;
    for (const [index, source] of backup.savedLinks.entries()) {
      const normalized = normalizedLinks[index].value;
      const exists = await linkCollection.findOne({ ownerId, url: normalized.url }, { projection: { _id: 1 } });
      if (exists) { skipped += 1; continue; }
      await linkCollection.insertOne({ _id: randomUUID(), ownerId, ...normalized, order: await linkCollection.countDocuments({ ownerId }), createdAt: new Date(), updatedAt: new Date() });
      savedLinksAdded += 1;
    }

    let quickNotesAdded = 0;
    for (const source of backup.quickNotes) {
      const content = normalizeQuickNoteContent(source.content);
      const exists = await quickCollection.findOne({ ownerId, content }, { projection: { _id: 1 } });
      if (exists) { skipped += 1; continue; }
      const now = new Date();
      await quickCollection.insertOne({ _id: randomUUID(), ownerId, content, title: quickNoteTitle(content), createdAt: now, updatedAt: now });
      quickNotesAdded += 1;
    }
    await db.collection('users').updateOne({ googleSub: ownerId }, { $set: { newsInterests: [...new Set(submittedInterests)].slice(0, 10), updatedAt: new Date() } });
    return json({ subjectsAdded, notesAdded, savedLinksAdded, quickNotesAdded, skipped });
  } catch (error) {
    console.error('POST /api/backup failed:', error?.name);
    return json({ error: 'Could not restore this backup. Some earlier records may already have been added; exporting a fresh backup is recommended before retrying.' }, 500);
  }
}
