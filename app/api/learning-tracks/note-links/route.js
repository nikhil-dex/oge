import { randomUUID } from 'node:crypto';
import { auth } from '../../../../auth.js';
import { getDatabase } from '../../../../lib/mongodb.js';
import { readLimitedBody } from '../../../../lib/read-limited-body.js';
import { checkOwnerMutationLimit, checkRateLimit, rateLimitResponse } from '../../../../lib/rate-limit.js';
import { withActiveOwnerMutation, ownerMutationFilter } from '../../../../lib/active-owner-mutation.js';
import { getVaultNoteClient, listVaultNotePage, readVaultNote } from '../../../../lib/oge-vault-notes.js';
import { VaultGitHubError } from '../../../../lib/oge-vault-github.js';
import {
  learningTrackNoteLinksEnabled, validLearningTrackNoteSelection, publicLessonNoteLink,
  verifyLessonNoteLinkReadOnly,
} from '../../../../lib/oge-learning-track-note-links.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const json = (data, status = 200) => Response.json(data, {
  status, headers: { 'Cache-Control': 'private, no-store' },
});
async function context() {
  const session = await auth();
  if (!session?.user?.id) return null;
  return { db: await getDatabase(), ownerId: session.user.id,
    sessionVersion: session.user.sessionVersion };
}
async function ownedTrack(ctx, trackId, session) {
  return ctx.db.collection('learningTracks').findOne({ _id: trackId, ownerId: ctx.ownerId },
    { session, projection: { _id: 1 } });
}
function failure(error) {
  if (error instanceof VaultGitHubError) {
    const status = error.message === 'session-expired' ? 401 :
      error.message === 'vault-not-connected' ? 409 :
        error.status === 404 ? 404 : 503;
    return json({ error: status === 409 ? 'Connect your private GitHub Vault first.' :
      status === 404 ? 'Committed GitHub Note not found.' :
        'Cannot verify the private GitHub Vault. No link was changed.' }, status);
  }
  if (error?.message === 'Account session no longer exists')
    return json({ error: 'Session changed. Sign in again before editing links.' }, 401);
  if (error?.code === 11000)
    return json({ error: 'This lesson has a new link from another device. Refresh.' }, 409);
  if (error instanceof TypeError) return json({ error: 'Invalid link request.' }, 400);
  console.error('Learning Tracks Note link error:', error?.name);
  return json({ error: 'Cannot confirm the link operation. Refresh before retrying.' }, 503);
}

export async function GET(request) {
  if (!learningTrackNoteLinksEnabled()) return json({ error: 'Private Note links preview disabled.' }, 404);
  try {
    const ctx = await context();
    if (!ctx) return json({ error: 'Sign in before viewing Note links.' }, 401);
    const q = new URL(request.url).searchParams;
    if (q.get('mode') === 'verify') {
      // Deliberate owner action: one link per request, eight checks/owner/hour.
      // Never trust a browser-supplied Note ID or claim persistent existence.
      const trackId = q.get('trackId');
      const videoId = q.get('videoId');
      if (!trackId || !UUID.test(trackId) ||
          !/^[A-Za-z0-9_-]{11}$/.test(videoId || ''))
        return json({ error: 'Select a valid linked lesson.' }, 400);
      if (!await ownedTrack(ctx, trackId))
        return json({ error: 'Learning track not found.' }, 404);
      const scope = { ownerId: ctx.ownerId, trackId, videoId };
      const collection = ctx.db.collection('learningTrackNoteLinks');
      const record = await collection.findOne(scope, { projection: { _id: 1, noteId: 1 } });
      if (!record) return json({ error: 'Link changed. Refresh before checking again.' }, 409);
      const limit = await checkRateLimit(ctx.db, { scope: 'learning-track-note-check',
        identifier: ctx.ownerId, limit: 8, windowMs: 3600000 });
      if (!limit.allowed) return rateLimitResponse(limit);
      const status = await verifyLessonNoteLinkReadOnly({
        record,
        createClient: () => getVaultNoteClient(ctx.db,
          { ownerId: ctx.ownerId, sessionVersion: ctx.sessionVersion }, { readOnly: true }),
        readNote: (client, noteId) => readVaultNote(client, noteId),
        sessionStillActive: async () => Boolean(await ctx.db.collection('users').findOne(
          ownerMutationFilter(ctx.ownerId, { sessionVersion: ctx.sessionVersion }),
          { projection: { _id: 1 } })),
        rereadLink: () => collection.findOne(scope, { projection: { _id: 1, noteId: 1 } }),
      });
      if (status === 'session-expired')
        return json({ error: 'Session changed. Sign in again before checking links.' }, 401);
      if (status === 'changed')
        return json({ error: 'Link changed on another device. Refresh before checking again.' }, 409);
      return json({ status, warning: 'Point-in-time private GitHub read only. No Note or link changed.' });
    }
    if (q.get('mode') === 'notes') {
      // Owner-only, server-side read-only GitHub App client. NO Note bodies in HTTP.
      const limit = await checkRateLimit(ctx.db, { scope: 'learning-track-note-picker',
        identifier: ctx.ownerId, limit: 12, windowMs: 3600000 });
      if (!limit.allowed) return rateLimitResponse(limit);
      const client = await getVaultNoteClient(ctx.db,
        { ownerId: ctx.ownerId, sessionVersion: ctx.sessionVersion }, { readOnly: true });
      const page = await listVaultNotePage(client, { cursor: q.get('cursor'), limit: 8 });
      return json({ notes: page.notes.map((note) => ({ id: note.id, heading: note.heading })),
        nextCursor: page.nextCursor, total: page.total });
    }
    const trackId = q.get('trackId');
    if (!trackId || !UUID.test(trackId)) return json({ error: 'Invalid learning track.' }, 400);
    if (!await ownedTrack(ctx, trackId)) return json({ error: 'Learning track not found.' }, 404);
    const links = await ctx.db.collection('learningTrackNoteLinks')
      .find({ ownerId: ctx.ownerId, trackId }).limit(500).toArray();
    return json({ links: links.map(publicLessonNoteLink),
      warning: 'These are owner-selected links, not proof that Note content still exists or the video belongs to this playlist.' });
  } catch (error) { return failure(error); }
}
export async function POST(request) {
  if (!learningTrackNoteLinksEnabled()) return json({ error: 'Private Note links preview disabled.' }, 404);
  let data;
  try { data = JSON.parse(await readLimitedBody(request, 4096)); }
  catch { return json({ error: 'Invalid JSON selection.' }, 400); }
  if (!validLearningTrackNoteSelection(data)) return json({ error: 'Choose a valid track, video and Note.' }, 400);
  try {
    const ctx = await context();
    if (!ctx) return json({ error: 'Sign in before linking Notes.' }, 401);
    const limit = await checkOwnerMutationLimit(ctx.db, ctx.ownerId, 'learning-tracks');
    if (!limit.allowed) return rateLimitResponse(limit);
    if (!await ownedTrack(ctx, data.trackId)) return json({ error: 'Learning track not found.' }, 404);
    // Prove Note ownership in the authenticated owner's CURRENT private GitHub repo.
    // No GitHub write token or new Notes content writer is available here.
    const client = await getVaultNoteClient(ctx.db,
      { ownerId: ctx.ownerId, sessionVersion: ctx.sessionVersion }, { readOnly: true });
    await readVaultNote(client, data.noteId);
    return await withActiveOwnerMutation(ctx.db, ctx.ownerId, async (session) => {
      if (!await ownedTrack(ctx, data.trackId, session))
        return json({ error: 'Learning track changed while linking.' }, 409);
      const links = ctx.db.collection('learningTrackNoteLinks');
      const scope = { ownerId: ctx.ownerId, trackId: data.trackId, videoId: data.videoId };
      if (await links.findOne(scope, { session, projection: { _id: 1 } }))
        return json({ error: 'Unlink the existing Note before adding another.' }, 409);
      if (await links.countDocuments({ ownerId: ctx.ownerId, trackId: data.trackId }, { session }) >= 500)
        return json({ error: 'This track reached the 500-link limit.' }, 409);
      const record = { _id: randomUUID(), ...scope, noteId: data.noteId, linkedAt: new Date() };
      await links.insertOne(record, { session });
      return json({ link: publicLessonNoteLink(record) }, 201);
    }, { sessionVersion: ctx.sessionVersion });
  } catch (error) { return failure(error); }
}
export async function DELETE(request) {
  if (!learningTrackNoteLinksEnabled()) return json({ error: 'Private Note links preview disabled.' }, 404);
  const q = new URL(request.url).searchParams;
  const data = { trackId: q.get('trackId'), videoId: q.get('videoId'), noteId: q.get('noteId') };
  if (!validLearningTrackNoteSelection(data)) return json({ error: 'Invalid Note link.' }, 400);
  try {
    const ctx = await context();
    if (!ctx) return json({ error: 'Sign in before unlinking Notes.' }, 401);
    const limit = await checkOwnerMutationLimit(ctx.db, ctx.ownerId, 'learning-tracks');
    if (!limit.allowed) return rateLimitResponse(limit);
    return await withActiveOwnerMutation(ctx.db, ctx.ownerId, async (session) => {
      const result = await ctx.db.collection('learningTrackNoteLinks')
        .deleteOne({ ownerId: ctx.ownerId, ...data }, { session });
      return result.deletedCount === 1 ? json({ unlinked: true }) :
        json({ error: 'Link changed on another device. Refresh links.' }, 409);
    }, { sessionVersion: ctx.sessionVersion });
  } catch (error) { return failure(error); }
}
