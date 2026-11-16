import { randomUUID } from 'node:crypto';
import { VaultGitHubError } from './oge-vault-github.js';
import {
  MAX_QUICK_NOTE_LENGTH, normalizeQuickNoteContent, quickNoteTitle,
} from './quick-notes.js';

/**
 * E2/M70 — GitHub-only standalone Quick Notes / AirNotes storage.
 * Separate typed paths prevent confusion with subject-linked notes/.
 *
 * These functions accept ONLY a signed-owner-created private GitHub App
 * client from getVaultNoteClient; never user-controlled repository URLs.
 * Zero MongoDB content writes, local queues, retries or background pushes.
 */
const TYPES = Object.freeze({
  'quick-notes': Object.freeze({
    path: 'quick-notes/', format: 'ogenotes-quick-note',
  }),
  airnotes: Object.freeze({
    path: 'airnotes/', format: 'ogenotes-airnote',
  }),
});
const NOTE_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{40}$/;
const MAX_CAPTURE_BYTES = 32 * 1024;
const MAX_TREE_ENTRIES = 30000;
const MAX_ITEMS = 300;
const MAX_READS = 5;
const fail = (name, status = 409) => new VaultGitHubError(name, status);
const typeOf = (kind) => {
  if (typeof kind !== 'string' || !Object.hasOwn(TYPES, kind))
    throw new TypeError('Invalid standalone Vault capture type');
  return TYPES[kind];
};
const checkId = (id) => {
  if (typeof id !== 'string' || !NOTE_UUID.test(id))
    throw new TypeError('Invalid standalone capture ID');
  return id.toLowerCase();
};
const checkSha = (sha) => {
  if (typeof sha !== 'string' || !SHA.test(sha))
    throw new TypeError('Exact GitHub revision SHA required');
  return sha;
};
const iso = (input) => {
  if (typeof input !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input) ||
      !Number.isFinite(Date.parse(input)) ||
      new Date(Date.parse(input)).toISOString() !== input)
    throw new TypeError('Invalid standalone note timestamp');
  return input;
};

export function standaloneCapturePath(kind, id) {
  return typeOf(kind).path + checkId(id) + '.json';
}

export function validatedStandaloneCapture(kind, input, {
  id = randomUUID(), now = new Date().toISOString(),
} = {}) {
  const type = typeOf(kind);
  const captureId = checkId(id);
  const updatedAt = iso(now);
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      typeof input.content !== 'string')
    throw new TypeError('Invalid standalone note content');
  const content = normalizeQuickNoteContent(input.content);
  if (content.length > MAX_QUICK_NOTE_LENGTH)
    throw new TypeError('Standalone note too long');
  const createdAt = input.createdAt === undefined
    ? updatedAt : iso(input.createdAt);
  if (Date.parse(createdAt) > Date.parse(updatedAt))
    throw new TypeError('Standalone note timestamps out of order');
  const note = {
    format: type.format, version: 1, id: captureId,
    content, title: quickNoteTitle(content), createdAt, updatedAt,
  };
  if (Buffer.byteLength(JSON.stringify(note), 'utf8') > MAX_CAPTURE_BYTES)
    throw new TypeError('Standalone note file too large');
  return note;
}

function validateCanonicalBlob(kind, id, sha, blob) {
  const type = typeOf(kind);
  if (!blob || blob.encoding !== 'base64' ||
      typeof blob.content !== 'string' ||
      (blob.sha !== undefined && blob.sha !== sha) ||
      (blob.size !== undefined && (!Number.isSafeInteger(blob.size) ||
        blob.size < 0 || blob.size > MAX_CAPTURE_BYTES))) {
    throw fail('vault-standalone-blob-corrupt');
  }
  const clean = blob.content.replace(/\s/g, '');
  if (!/^[a-zA-Z0-9+/]*={0,2}$/.test(clean)) throw fail('vault-standalone-blob-corrupt');
  const bytes = Buffer.from(clean, 'base64');
  if (bytes.length > MAX_CAPTURE_BYTES ||
      bytes.toString('base64') !== clean ||
      (blob.size !== undefined && bytes.length !== blob.size))
    throw fail('vault-standalone-blob-corrupt');
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const checked = validatedStandaloneCapture(kind, parsed, {
      id, now: parsed.updatedAt,
    });
    if (Object.keys(parsed).sort().join(',') !==
        'content,createdAt,format,id,title,updatedAt,version' ||
        JSON.stringify(parsed) !== JSON.stringify(checked) ||
        parsed.format !== type.format || parsed.version !== 1)
      throw new TypeError('Untrusted standalone note');
  } catch {
    throw fail('vault-standalone-blob-corrupt');
  } finally { bytes.fill(0); }
  return { ...parsed, sha };
}

export async function readVaultStandaloneSnapshot(client, kind) {
  const type = typeOf(kind);
  if (!client || typeof client.call !== 'function' ||
      typeof client.branch !== 'string' ||
      !/^[a-zA-Z0-9_.-]{1,100}$/.test(client.branch) ||
      client.branch.startsWith('-') || client.branch.includes('..'))
    throw new TypeError('Signed Vault GitHub client required');
  const refPath = '/git/ref/heads/' + encodeURIComponent(client.branch);
  const ref = await client.call(refPath);
  const head = ref?.object?.sha;
  if (!SHA.test(head || '')) throw fail('vault-standalone-head-invalid');
  const commit = await client.call('/git/commits/' + head);
  const treeSha = commit?.tree?.sha;
  if (!SHA.test(treeSha || '')) throw fail('vault-standalone-tree-invalid');
  const tree = await client.call('/git/trees/' + treeSha + '?recursive=1');
  if (!Array.isArray(tree?.tree) || tree.truncated === true ||
      tree.tree.length > MAX_TREE_ENTRIES)
    throw fail('vault-standalone-tree-invalid');

  const files = new Map();
  for (const entry of tree.tree) {
    if (typeof entry?.path !== 'string' ||
        !entry.path.startsWith(type.path)) continue;
    const id = entry.path.slice(type.path.length, -5);
    if (entry.type !== 'blob' || entry.mode !== '100644' ||
        !entry.path.endsWith('.json') || !NOTE_UUID.test(id) ||
        entry.path !== standaloneCapturePath(kind, id) ||
        !SHA.test(entry.sha || '') ||
        (entry.size !== undefined &&
          (!Number.isSafeInteger(entry.size) ||
          entry.size < 0 || entry.size > MAX_CAPTURE_BYTES)) ||
        files.has(id))
      throw fail('vault-standalone-directory-invalid');
    files.set(id, { sha: entry.sha, path: entry.path });
  }
  if (files.size > MAX_ITEMS)
    throw fail('vault-standalone-list-too-large');
  return { head, treeSha, files, refPath };
}

async function readBySha(client, kind, id, sha) {
  const checked = checkSha(sha);
  const blob = await client.call('/git/blobs/' + checked);
  return validateCanonicalBlob(kind, checkId(id), checked, blob);
}

async function checkStableHead(client, snapshot) {
  const ref = await client.call(snapshot.refPath);
  if (ref?.object?.sha !== snapshot.head)
    throw fail('vault-standalone-head-changed');
}

export async function listVaultStandaloneCaptures(client, kind) {
  const snapshot = await readVaultStandaloneSnapshot(client, kind);
  const items = [...snapshot.files.entries()].sort(([a], [b]) =>
    a.localeCompare(b));
  const captures = [];
  for (let i = 0; i < items.length; i += MAX_READS) {
    captures.push(...await Promise.all(items.slice(i, i + MAX_READS)
      .map(([id, file]) => readBySha(client, kind, id, file.sha))));
  }
  await checkStableHead(client, snapshot);
  return captures.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getVaultStandaloneCapture(client, kind, id) {
  const checked = checkId(id);
  const snapshot = await readVaultStandaloneSnapshot(client, kind);
  const info = snapshot.files.get(checked);
  if (!info) throw fail('vault-standalone-not-found', 404);
  const capture = await readBySha(client, kind, checked, info.sha);
  await checkStableHead(client, snapshot);
  return capture;
}

/**
 * One create/update/delete through exactly ONE non-fast-forward Git ref PATCH.
 * Unknown outcomes stay unknown: NO automatic replay of Git writes.
 * For updates/deletes the exact SHA is required. For creates the caller must
 * choose the stable UUID before submitting, for later read-only recovery.
 */
export async function commitVaultStandaloneCapture(client, {
  kind, action, id, content, sha = null,
}, { now = new Date().toISOString() } = {}) {
  typeOf(kind);
  const checkedId = checkId(id);
  if (!['create', 'update', 'delete'].includes(action) ||
      (action === 'create' ? sha !== null : !SHA.test(sha || '')) ||
      (action === 'delete' ? content !== undefined : typeof content !== 'string'))
    throw new TypeError('Invalid standalone capture mutation');
  if (client?.readOnly === true)
    throw new TypeError('Read-only Vault token cannot modify captures');
  const snapshot = await readVaultStandaloneSnapshot(client, kind);
  const previous = snapshot.files.get(checkedId);
  const previousSha = previous?.sha || null;
  if (previousSha !== sha)
    throw fail('vault-standalone-conflict');

  let note = null;
  if (action !== 'delete') {
    const existing = action === 'update' ?
      await readBySha(client, kind, checkedId, previousSha) : null;
    note = validatedStandaloneCapture(kind, {
      content, ...(existing ? { createdAt: existing.createdAt } : {}),
    }, { id: checkedId, now });
  }
  const change = { path: standaloneCapturePath(kind, checkedId),
    mode: '100644', type: 'blob',
    ...(note ? { content: JSON.stringify(note) + '\n' } : { sha: null }),
  };

  // Stale HEAD is always rejected BEFORE initiating any Git write.
  await checkStableHead(client, snapshot);
  const newTree = await client.call('/git/trees', { method: 'POST',
    body: { base_tree: snapshot.treeSha, tree: [change] } });
  if (!SHA.test(newTree?.sha || ''))
    throw fail('vault-standalone-tree-unconfirmed', 503);
  const newCommit = await client.call('/git/commits', { method: 'POST',
    body: { message: 'Sync Oge Vault ' + kind + ' entry', tree: newTree.sha,
      parents: [snapshot.head] } });
  if (!SHA.test(newCommit?.sha || ''))
    throw fail('vault-standalone-commit-unconfirmed', 503);
  let patchError = null;
  try {
    await client.call(snapshot.refPath, { method: 'PATCH',
      body: { sha: newCommit.sha, force: false } });
  } catch (error) { patchError = error; }

  let headAfter;
  try { headAfter = await client.call(snapshot.refPath); }
  catch { throw fail('vault-standalone-write-unconfirmed', 503); }
  if (headAfter?.object?.sha !== newCommit.sha) {
    if (patchError instanceof VaultGitHubError &&
        [409, 422].includes(patchError.status))
      throw fail('vault-standalone-conflict');
    throw fail('vault-standalone-write-unconfirmed', 503);
  }
  const committed = await client.call('/git/commits/' + newCommit.sha)
    .catch(() => { throw fail('vault-standalone-write-unconfirmed', 503); });
  if (committed?.tree?.sha !== newTree.sha ||
      !Array.isArray(committed.parents) ||
      !committed.parents.some(p =>
        (typeof p === 'string' ? p : p?.sha) === snapshot.head))
    throw fail('vault-standalone-write-unconfirmed', 503);

  // A second verified immutable HEAD snapshot proves the correct file
  // is present (or absent) under its OWN directory after the ref move.
  let finalState;
  try { finalState = await readVaultStandaloneSnapshot(client, kind); }
  catch { throw fail('vault-standalone-write-unconfirmed', 503); }
  if (finalState.head !== newCommit.sha ||
      (action === 'delete' && finalState.files.has(checkedId)))
    throw fail('vault-standalone-write-unconfirmed', 503);
  if (action === 'delete') {
    await checkStableHead(client, finalState);
    return { kind, id: checkedId, deleted: true, commitSha: newCommit.sha };
  }
  const savedSha = finalState.files.get(checkedId)?.sha;
  if (!SHA.test(savedSha || ''))
    throw fail('vault-standalone-write-unconfirmed', 503);
  let verified;
  try { verified = await readBySha(client, kind, checkedId, savedSha); }
  catch { throw fail('vault-standalone-write-unconfirmed', 503); }
  if (JSON.stringify({ ...verified, sha: undefined }) !==
      JSON.stringify({ ...note, sha: undefined }))
    throw fail('vault-standalone-write-unconfirmed', 503);
  await checkStableHead(client, finalState);
  return { kind, ...verified, commitSha: newCommit.sha };
}
