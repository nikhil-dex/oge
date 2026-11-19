import { randomUUID } from 'node:crypto';
import { VaultGitHubError } from './oge-vault-github.js';
import {
  MAX_MEDIA_FILE_BYTES, MAX_MEDIA_FILES, MAX_MEDIA_FOLDERS,
  MAX_MEDIA_TOTAL_BYTES, MAX_MEDIA_CHUNKS, VAULT_MEDIA_CHUNK_BYTES,
  isValidMediaId, isValidFolderId, normalizeFolderName,
  normalizeMediaFile, hasValidMediaSignature,
} from './oge-vault-media-validation.js';

export const VAULT_MEDIA_INDEX_PATH = 'files/index.json';
export const VAULT_MEDIA_PART_PREFIX = 'files/objects/';
const SHA = /^[0-9a-f]{40}$/i;
const MAX_INDEX_BYTES = 512 * 1024;
const MAX_TREE_ENTRIES = 30000;
const fail = (reason, status = 409) => new VaultGitHubError(reason, status);
const validSha = value => typeof value === 'string' && SHA.test(value);
const today = () => new Date().toISOString();

export function mediaPartPath(id, index) {
  if (!isValidMediaId(id) || !Number.isSafeInteger(index) ||
      index < 0 || index >= MAX_MEDIA_CHUNKS)
    throw new TypeError('Invalid file chunk');
  return VAULT_MEDIA_PART_PREFIX + id.toLowerCase() + '/part-' +
    String(index).padStart(4, '0');
}
function canonicalEmpty() {
  return { format: 'oge-vault-media', version: 1, updatedAt: today(),
    folders: [], files: [] };
}
function assertManifest(doc) {
  if (!doc || doc.format !== 'oge-vault-media' || doc.version !== 1 ||
      typeof doc.updatedAt !== 'string' || !Number.isFinite(Date.parse(doc.updatedAt)) ||
      !Array.isArray(doc.folders) || doc.folders.length > MAX_MEDIA_FOLDERS ||
      !Array.isArray(doc.files) || doc.files.length > MAX_MEDIA_FILES)
    throw fail('vault-files-index-invalid');
  const folderIds = new Set();
  const folderNames = new Set();
  for (const folder of doc.folders) {
    const name = normalizeFolderName(folder?.name);
    if (!isValidMediaId(folder?.id) || folder.id !== folder.id.toLowerCase() ||
        name.error || name.value !== folder.name || folderIds.has(folder.id) ||
        folderNames.has(folder.name.toLowerCase()) ||
        typeof folder.createdAt !== 'string' ||
        !Number.isFinite(Date.parse(folder.createdAt)) ||
        typeof folder.updatedAt !== 'string' ||
        !Number.isFinite(Date.parse(folder.updatedAt)))
      throw fail('vault-files-index-invalid');
    folderIds.add(folder.id);
    folderNames.add(folder.name.toLowerCase());
  }
  let total = 0;
  const fileIds = new Set();
  for (const file of doc.files) {
    const normalized = normalizeMediaFile(file);
    if (!isValidMediaId(file?.id) || file.id !== file.id.toLowerCase() ||
        normalized.error || file.name !== normalized.value.name ||
        file.type !== normalized.value.type ||
        file.extension !== normalized.value.extension ||
        !isValidFolderId(file.folderId) ||
        (file.folderId && !folderIds.has(file.folderId)) ||
        fileIds.has(file.id) ||
        !Array.isArray(file.parts) ||
        file.parts.length !== Math.ceil(file.size / VAULT_MEDIA_CHUNK_BYTES) ||
        file.parts.length > MAX_MEDIA_CHUNKS ||
        file.parts.some((part, i) =>
          !validSha(part?.sha) || !Number.isSafeInteger(part.size) ||
          part.size !== (i === file.parts.length - 1
            ? file.size - VAULT_MEDIA_CHUNK_BYTES * i : VAULT_MEDIA_CHUNK_BYTES)) ||
        typeof file.createdAt !== 'string' ||
        !Number.isFinite(Date.parse(file.createdAt)) ||
        typeof file.updatedAt !== 'string' ||
        !Number.isFinite(Date.parse(file.updatedAt)))
      throw fail('vault-files-index-invalid');
    fileIds.add(file.id);
    total += file.size;
  }
  if (total > MAX_MEDIA_TOTAL_BYTES) throw fail('vault-files-total-too-large');
  return doc;
}
function readBlob(body, sha, maxBytes = MAX_INDEX_BYTES) {
  if (!validSha(sha) || body?.sha !== sha ||
      body?.encoding !== 'base64' || typeof body.content !== 'string' ||
      !Number.isSafeInteger(body.size) ||
      body.size < 0 || body.size > maxBytes)
    throw fail('vault-files-blob-invalid');
  const bytes = Buffer.from(body.content.replace(/\s/g, ''), 'base64');
  if (bytes.length !== body.size || bytes.length > maxBytes)
    throw fail('vault-files-blob-invalid');
  return bytes;
}
export async function readVaultMediaBlob(client, sha, size) {
  if (!validSha(sha) || !Number.isSafeInteger(size) ||
      size < 1 || size > VAULT_MEDIA_CHUNK_BYTES)
    throw new TypeError('Invalid GitHub file chunk reference');
  const body = await client.call('/git/blobs/' + sha);
  const bytes = readBlob(body, sha, VAULT_MEDIA_CHUNK_BYTES);
  if (bytes.length !== size) throw fail('vault-files-chunk-size-mismatch');
  return bytes;
}
export async function createVaultMediaBlob(client, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 ||
      bytes.length > VAULT_MEDIA_CHUNK_BYTES)
    throw new TypeError('Chunk must be between 1 byte and 2 MiB');
  if (client?.readOnly) throw new TypeError('Read-only Vault');
  const blob = await client.call('/git/blobs', {
    method: 'POST',
    body: { content: bytes.toString('base64'), encoding: 'base64' },
  });
  if (!validSha(blob?.sha)) throw fail('vault-files-chunk-upload-unconfirmed', 503);
  return { sha: blob.sha, size: bytes.length };
}
export async function readVaultMediaSnapshot(client) {
  if (!client || typeof client.call !== 'function' ||
      typeof client.branch !== 'string' || !/^[a-zA-Z0-9_.-]{1,100}$/.test(client.branch) ||
      client.branch.startsWith('-') || client.branch.includes('..'))
    throw new TypeError('Signed GitHub Vault client required');
  const refPath = '/git/ref/heads/' + encodeURIComponent(client.branch);
  const ref = await client.call(refPath);
  const head = ref?.object?.sha;
  if (!validSha(head)) throw fail('vault-files-head-invalid');
  const commit = await client.call('/git/commits/' + head);
  const treeSha = commit?.tree?.sha;
  if (!validSha(treeSha)) throw fail('vault-files-tree-invalid');
  const tree = await client.call('/git/trees/' + treeSha + '?recursive=1');
  if (!Array.isArray(tree?.tree) || tree.truncated === true ||
      tree.tree.length > MAX_TREE_ENTRIES)
    throw fail('vault-files-tree-invalid');
  const map = new Map();
  for (const entry of tree.tree) {
    if (typeof entry?.path !== 'string' || !entry.path.startsWith('files/')) continue;
    // Recursive GitHub trees also list the parent directories. Only
    // ordinary blobs are media entries; folder tree nodes aren't files.
    if (entry.type === 'tree') continue;
    if (map.has(entry.path) || entry.mode !== '100644' ||
        entry.type !== 'blob' || !validSha(entry.sha))
      throw fail('vault-files-tree-invalid');
    map.set(entry.path, entry);
  }
  const info = map.get(VAULT_MEDIA_INDEX_PATH);
  let doc = canonicalEmpty();
  if (info) {
    const buffer = readBlob(await client.call('/git/blobs/' + info.sha),
      info.sha, MAX_INDEX_BYTES);
    try {
      doc = assertManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true })
        .decode(buffer)));
    } catch { throw fail('vault-files-index-invalid'); }
  }
  for (const file of doc.files) {
    for (let i = 0; i < file.parts.length; i++) {
      const entry = map.get(mediaPartPath(file.id, i));
      if (!entry || entry.sha !== file.parts[i].sha ||
          (entry.size !== undefined && entry.size !== file.parts[i].size))
        throw fail('vault-files-index-blob-mismatch');
    }
  }
  return { head, treeSha, refPath, map, doc };
}
async function assertSameHead(client, snapshot) {
  const ref = await client.call(snapshot.refPath);
  if (ref?.object?.sha !== snapshot.head) throw fail('vault-files-changed');
}
function makeTreeDelete(file) {
  return file.parts.map((_, i) => ({
    path: mediaPartPath(file.id, i),
    mode: '100644', type: 'blob', sha: null,
  }));
}
function publicFile(file) {
  const { parts, ...rest } = file;
  return rest;
}
export function mediaList(snapshot, folderId = null) {
  if (!isValidFolderId(folderId)) throw new TypeError('Invalid folder');
  const folder = folderId || null;
  return {
    currentFolderId: folder,
    folders: snapshot.doc.folders,
    files: snapshot.doc.files.filter(f => f.folderId === folder).map(publicFile),
  };
}
export async function applyVaultMediaMutation(client, action, input = {}) {
  if (client?.readOnly) throw new TypeError('Read-only Vault');
  const before = await readVaultMediaSnapshot(client);
  const doc = before.doc;
  const folders = [...doc.folders];
  const files = [...doc.files];
  const id = typeof input.id === 'string' ? input.id.toLowerCase() : '';
  let output, additions = [];
  const timestamp = today();
  if (action === 'create-folder') {
    const name = normalizeFolderName(input.name);
    if (name.error) throw new TypeError(name.error);
    if (folders.length >= MAX_MEDIA_FOLDERS) throw fail('vault-files-folder-limit');
    if (folders.some(f => f.name.toLowerCase() === name.value.toLowerCase()))
      throw fail('vault-files-folder-exists');
    const newId = isValidMediaId(id) ? id : randomUUID();
    if (folders.some(f => f.id === newId)) throw fail('vault-files-folder-id-exists');
    output = { id: newId, name: name.value, createdAt: timestamp, updatedAt: timestamp };
    folders.push(output);
  } else if (action === 'rename-folder') {
    const target = folders.find(f => f.id === id);
    if (!target) throw fail('vault-files-folder-not-found', 404);
    const name = normalizeFolderName(input.name);
    if (name.error) throw new TypeError(name.error);
    if (folders.some(f => f.id !== id && f.name.toLowerCase() === name.value.toLowerCase()))
      throw fail('vault-files-folder-exists');
    output = { ...target, name: name.value, updatedAt: timestamp };
    folders.splice(folders.indexOf(target), 1, output);
  } else if (action === 'delete-folder') {
    const index = folders.findIndex(f => f.id === id);
    if (index < 0) throw fail('vault-files-folder-not-found', 404);
    folders.splice(index, 1);
    for (let i = files.length - 1; i >= 0; i--) {
      if (files[i].folderId === id) {
        additions.push(...makeTreeDelete(files[i]));
        files.splice(i, 1);
      }
    }
    output = { deleted: id };
  } else if (action === 'upload-file') {
    const norm = normalizeMediaFile(input);
    if (norm.error) throw new TypeError(norm.error);
    if (!isValidMediaId(id) || !isValidFolderId(input.folderId))
      throw new TypeError('Invalid file ID or folder');
    const folderId = input.folderId || null;
    if (folderId && !folders.some(f => f.id === folderId))
      throw fail('vault-files-folder-not-found', 404);
    const existing = files.find(f => f.id === id);
    if (existing) {
      if (existing.name === norm.value.name &&
          existing.type === norm.value.type && existing.size === norm.value.size)
        return publicFile(existing); // Uncertain response, same ID already committed.
      throw fail('vault-files-id-conflict');
    }
    if (files.length >= MAX_MEDIA_FILES ||
        files.reduce((size, f) => size + f.size, 0) + norm.value.size > MAX_MEDIA_TOTAL_BYTES)
      throw fail('vault-files-limit-reached', 413);
    const parts = input.parts;
    if (!Array.isArray(parts) ||
        parts.length !== Math.ceil(norm.value.size / VAULT_MEDIA_CHUNK_BYTES) ||
        parts.some((part, i) => !validSha(part?.sha) ||
          part.size !== (i === parts.length - 1
            ? norm.value.size - i * VAULT_MEDIA_CHUNK_BYTES : VAULT_MEDIA_CHUNK_BYTES)))
      throw new TypeError('Upload chunks are incomplete or invalid');

    // Verify every uploaded immutable blob in this specific private Vault
    // BEFORE referencing it from a new commit. ZIP content is not executed.
    let first = null;
    for (let i = 0; i < parts.length; i++) {
      const bytes = await readVaultMediaBlob(client, parts[i].sha, parts[i].size);
      if (i === 0) first = bytes.subarray(0, 16);
    }
    if (!hasValidMediaSignature(first, norm.value.type))
      throw new TypeError('The file contents do not match its PDF, ZIP or image type.');
    output = {
      id, ...norm.value, folderId, parts,
      createdAt: timestamp, updatedAt: timestamp,
    };
    files.push(output);
    additions.push(...parts.map((part, i) => ({
      path: mediaPartPath(id, i), mode: '100644', type: 'blob', sha: part.sha,
    })));
  } else if (action === 'rename-file' || action === 'move-file' || action === 'delete-file') {
    const index = files.findIndex(f => f.id === id);
    if (index < 0) throw fail('vault-files-file-not-found', 404);
    const current = files[index];
    if (action === 'delete-file') {
      additions = makeTreeDelete(current);
      files.splice(index, 1);
      output = { deleted: id };
    } else if (action === 'move-file') {
      if (!isValidFolderId(input.folderId)) throw new TypeError('Invalid folder');
      const dest = input.folderId || null;
      if (dest && !folders.some(f => f.id === dest))
        throw fail('vault-files-folder-not-found', 404);
      output = { ...current, folderId: dest, updatedAt: timestamp };
      files[index] = output;
    } else {
      const normalized = normalizeMediaFile({
        name: input.name, type: current.type, size: current.size,
      });
      if (normalized.error) throw new TypeError(normalized.error);
      output = { ...current, name: normalized.value.name, updatedAt: timestamp };
      files[index] = output;
    }
  } else throw new TypeError('Unknown file library action');
  const next = assertManifest({
    format: 'oge-vault-media', version: 1, updatedAt: timestamp,
    folders, files,
  });
  if (Buffer.byteLength(JSON.stringify(next)) > MAX_INDEX_BYTES)
    throw fail('vault-files-index-too-large', 413);
  await assertSameHead(client, before);
  const tree = await client.call('/git/trees', { method: 'POST', body: {
    base_tree: before.treeSha,
    tree: [
      { path: VAULT_MEDIA_INDEX_PATH, mode: '100644', type: 'blob',
        content: JSON.stringify(next, null, 2) + '\n' },
      ...additions,
    ],
  } });
  if (!validSha(tree?.sha)) throw fail('vault-files-tree-unconfirmed', 503);
  const commit = await client.call('/git/commits', { method: 'POST',
    body: { message: 'Update Oge Files', tree: tree.sha, parents: [before.head] } });
  if (!validSha(commit?.sha)) throw fail('vault-files-commit-unconfirmed', 503);
  let error;
  try {
    await client.call('/git/refs/heads/' + encodeURIComponent(client.branch), {
      method: 'PATCH', body: { sha: commit.sha, force: false },
    });
  } catch (e) { error = e; }
  let after;
  try { after = await readVaultMediaSnapshot(client); }
  catch { throw fail('vault-files-save-unconfirmed', 503); }
  if (after.head !== commit.sha ||
      JSON.stringify(after.doc) !== JSON.stringify(next)) {
    if (error instanceof VaultGitHubError && [409, 422].includes(error.status))
      throw fail('vault-files-conflict', 409);
    throw fail('vault-files-save-unconfirmed', 503);
  }
  return action === 'upload-file' ? publicFile(output) :
    action === 'rename-file' || action === 'move-file' ? publicFile(output) : output;
}
export function vaultMediaRecord(snapshot, id) {
  if (!isValidMediaId(id)) throw new TypeError('Invalid file ID');
  const file = snapshot.doc.files.find(item => item.id === id.toLowerCase());
  if (!file) throw fail('vault-files-file-not-found', 404);
  return file;
}
