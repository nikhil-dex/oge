import { auth } from '../../../../auth.js';
import { getDatabase } from '../../../../lib/mongodb.js';
import { ownerMutationFilter } from '../../../../lib/active-owner-mutation.js';
import { getVaultNoteClient } from '../../../../lib/oge-vault-notes.js';
import { VaultGitHubError } from '../../../../lib/oge-vault-github.js';
import { withVaultOwnerDraftWrite } from '../../../../lib/oge-vault-import-fence.js';
import { checkOwnerMutationLimit, rateLimitResponse } from '../../../../lib/rate-limit.js';
import { readLimitedBody } from '../../../../lib/read-limited-body.js';
import {
  githubVaultFilesEnabled, isValidMediaId, VAULT_MEDIA_CHUNK_BYTES,
  MAX_MEDIA_CHUNKS,
} from '../../../../lib/oge-vault-media-validation.js';
import {
  createVaultMediaBlob, readVaultMediaSnapshot, mediaList,
  applyVaultMediaMutation, vaultMediaRecord, readVaultMediaBlob,
} from '../../../../lib/oge-vault-media.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (data, status = 200) => Response.json(data, {
  status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
});
async function context({ readOnly = false } = {}) {
  const session = await auth();
  if (!session?.user?.id) throw new VaultGitHubError('Sign in to use My Files.', 401);
  const db = await getDatabase();
  const ownerId = session.user.id, sessionVersion = session.user.sessionVersion;
  const user = await db.collection('users').findOne(
    ownerMutationFilter(ownerId, { sessionVersion }),
    { projection: { vault: 1, notesStorage: 1 } },
  );
  if (!user) throw new VaultGitHubError('Session expired. Sign in again.', 401);
  if (!githubVaultFilesEnabled(user))
    throw new VaultGitHubError('My Files requires a connected GitHub Vault.', 403);
  const client = await getVaultNoteClient(db, { ownerId, sessionVersion }, { readOnly });
  return { db, client, ownerId, sessionVersion };
}
function errorResponse(error) {
  if (error instanceof VaultGitHubError) {
    return json({ error: error.message },
      [400, 401, 403, 404, 409, 413, 416, 429].includes(error.status) ? error.status : 503);
  }
  if (error instanceof TypeError || error instanceof SyntaxError)
    return json({ error: error.message }, 400);
  console.error('Vault My Files error:', error?.name);
  return json({ error: 'Could not complete the file operation. Refresh My Files before retrying.' }, 503);
}
async function jsonBody(request) {
  try { return JSON.parse(await readLimitedBody(request, 32 * 1024)); }
  catch (error) {
    throw new VaultGitHubError(error?.status === 413
      ? 'File request too large.' : 'Enter valid file information.',
    error?.status === 413 ? 413 : 400);
  }
}
async function boundedBinary(request) {
  const max = VAULT_MEDIA_CHUNK_BYTES;
  const length = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(length) && length > max)
    throw new VaultGitHubError('Upload chunk too large.', 413);
  if (!request.body) throw new TypeError('Missing file chunk');
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => {});
        throw new VaultGitHubError('Upload chunk too large.', 413);
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  if (total < 1) throw new TypeError('File chunk is empty');
  return Buffer.concat(chunks, total);
}
function contentHeaders(file, start, end, isRange, download) {
  const safeName = file.name.replace(/[^\x20-\x7E]|["\\\r\n]/g, '_') || 'download';
  const headers = {
    'Content-Type': file.type,
    'Content-Length': String(end - start + 1),
    'Content-Disposition': (download || file.type === 'application/zip'
      ? 'attachment; filename="' : 'inline; filename="') + safeName + '"',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
  };
  if (isRange) headers['Content-Range'] =
    'bytes ' + start + '-' + end + '/' + file.size;
  return headers;
}
function byteRange(request, size) {
  const range = request.headers.get('range');
  if (!range) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d+)-(\d*)$/.exec(range);
  if (!match) throw new VaultGitHubError('Invalid file byte range.', 416);
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      start >= size || end >= size || end < start)
    throw new VaultGitHubError('Invalid file byte range.', 416);
  return { start, end, partial: true };
}
async function contentResponse(request, ctx, id, download) {
  const snapshot = await readVaultMediaSnapshot(ctx.client);
  const file = vaultMediaRecord(snapshot, id);
  const { start, end, partial } = byteRange(request, file.size);
  let index = Math.floor(start / VAULT_MEDIA_CHUNK_BYTES);
  const endPart = Math.floor(end / VAULT_MEDIA_CHUNK_BYTES);
  const stream = new ReadableStream({
    async pull(controller) {
      if (index > endPart) { controller.close(); return; }
      try {
        const part = file.parts[index];
        const bytes = await readVaultMediaBlob(ctx.client, part.sha, part.size);
        const base = index * VAULT_MEDIA_CHUNK_BYTES;
        const slice = bytes.subarray(
          Math.max(0, start - base), Math.min(bytes.length, end - base + 1));
        index++;
        controller.enqueue(new Uint8Array(slice));
      } catch (error) { controller.error(error); }
    },
  });
  return new Response(stream, {
    status: partial ? 206 : 200,
    headers: contentHeaders(file, start, end, partial, download),
  });
}
export async function GET(request) {
  try {
    const ctx = await context({ readOnly: true });
    const params = new URL(request.url).searchParams;
    const action = params.get('action');
    if (action === 'download') {
      const id = params.get('id') || '';
      const snapshot = await readVaultMediaSnapshot(ctx.client);
      vaultMediaRecord(snapshot, id);
      const href = '/api/vault/media?action=content&id=' + encodeURIComponent(id) +
        (params.get('disposition') === 'attachment' ? '&disposition=attachment' : '');
      return json({ url: href });
    }
    if (action === 'content')
      return await contentResponse(request, ctx,
        params.get('id') || '', params.get('disposition') === 'attachment');
    const folderId = params.get('folderId') || null;
    const snapshot = await readVaultMediaSnapshot(ctx.client);
    return json(mediaList(snapshot, folderId));
  } catch (error) { return errorResponse(error); }
}
async function saveMutation(ctx, action, input) {
  const limit = await checkOwnerMutationLimit(ctx.db, ctx.ownerId, 'media');
  if (!limit.allowed) return rateLimitResponse(limit);
  const result = await withVaultOwnerDraftWrite(ctx.db, {
    ownerId: ctx.ownerId, sessionVersion: ctx.sessionVersion,
    repoId: ctx.client.vault.repoId,
  }, () => applyVaultMediaMutation(ctx.client, action, input));
  return json(result, ['create-folder', 'upload-file'].includes(action) ? 201 : 200);
}
export async function POST(request) {
  try {
    const ctx = await context();
    const params = new URL(request.url).searchParams;
    if (params.get('action') === 'upload-chunk') {
      // File bytes travel to GitHub via the authenticated Oge server.
      // No long-lived file copy, metadata, or content in MongoDB.
      const id = params.get('id'), part = Number(params.get('part'));
      if (!isValidMediaId(id) || !Number.isSafeInteger(part) ||
          part < 0 || part >= MAX_MEDIA_CHUNKS)
        throw new TypeError('Invalid upload chunk ID or number');
      const limit = await checkOwnerMutationLimit(ctx.db, ctx.ownerId, 'media');
      if (!limit.allowed) return rateLimitResponse(limit);
      const bytes = await boundedBinary(request);
      return json(await createVaultMediaBlob(ctx.client, bytes), 201);
    }
    const data = await jsonBody(request);
    if (data?.action === 'create-folder' || data?.action === 'upload-file')
      return await saveMutation(ctx, data.action, data);
    return json({ error: 'Unsupported file action.' }, 400);
  } catch (error) { return errorResponse(error); }
}
export async function PATCH(request) {
  try {
    const ctx = await context();
    const data = await jsonBody(request);
    if (!['rename-folder', 'rename-file', 'move-file'].includes(data?.action))
      return json({ error: 'Unsupported file action.' }, 400);
    return await saveMutation(ctx, data.action, data);
  } catch (error) { return errorResponse(error); }
}
export async function DELETE(request) {
  try {
    const ctx = await context();
    const params = new URL(request.url).searchParams;
    const id = params.get('id') || '';
    const action = params.get('type') === 'folder'
      ? 'delete-folder' : 'delete-file';
    if (!isValidMediaId(id)) throw new TypeError('Invalid file or folder ID');
    return await saveMutation(ctx, action, { id });
  } catch (error) { return errorResponse(error); }
}
