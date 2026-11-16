import { randomUUID } from 'node:crypto';
import { githubAppJwt, vaultGithubRequest, VaultGitHubError, VAULT_REPO_NAME } from './oge-vault-github.js';
import { ownerMutationFilter } from './active-owner-mutation.js';

/**
 * Experimental content-only GitHub data layer.
 * No note text, heading, revision or retry payload is sent to MongoDB.
 * Gate all consumers until the other note-writing APIs have been migrated.
 */
const NOTE_PREFIX = 'notes/';
const NOTE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUBJECT_ID = NOTE_ID;
const SHA = /^[0-9a-f]{40}$/;
const LOGIN = /^[a-zA-Z0-9-]{1,39}$/;
const MAX_NOTES_PER_LIST = 500;
const MAX_NOTE_BYTES = 32 * 1024;
export const MAX_VAULT_NOTE_BYTES = MAX_NOTE_BYTES;
export const MAX_VAULT_BATCH_ITEMS = 12;

export function noteFilePath(id) {
  if (typeof id !== 'string' || !NOTE_ID.test(id)) throw new TypeError('Invalid note ID');
  return NOTE_PREFIX + id.toLowerCase() + '.json';
}

export function validatedNote(input, { id = randomUUID(), now = new Date().toISOString() } = {}) {
  const heading = typeof input?.heading === 'string' ? input.heading.trim() : '';
  const answer = typeof input?.answer === 'string' ? input.answer.trim() : '';
  const subjectId = input?.subjectId;
  if (!NOTE_ID.test(id) || !SUBJECT_ID.test(subjectId || '') ||
      !heading || heading.length > 160 || !answer || answer.length > 20000) {
    throw new TypeError('Invalid subject, heading or note content');
  }
  if (input?.favorite !== undefined && typeof input.favorite !== 'boolean') {
    throw new TypeError('Invalid favorite flag');
  }
  const tags = input.tags === undefined ? [] : input.tags;
  if (!Array.isArray(tags) || tags.length > 10 ||
      tags.some((tag) => typeof tag !== 'string' || !tag.trim() || tag.length > 40)) {
    throw new TypeError('Invalid note tags');
  }
  if (!Number.isFinite(Date.parse(now))) throw new TypeError('Invalid updated timestamp');
  const result = {
    format: 'ogenotes-note', version: 1, id: id.toLowerCase(),
    subjectId: subjectId.toLowerCase(), heading, answer,
    tags: [...new Set(tags.map((tag) => tag.trim().toLowerCase()))],
    favorite: input.favorite === true, updatedAt: now,
    createdAt: typeof input.createdAt === 'string' && !Number.isNaN(Date.parse(input.createdAt))
      ? input.createdAt : now,
  };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_NOTE_BYTES) throw new TypeError('Note file too large');
  return result;
}

function validateVault(vault) {
  if (!vault || vault.status !== 'connected' ||
      !Number.isSafeInteger(vault.installationId) || vault.installationId <= 0 ||
      !Number.isSafeInteger(vault.repoId) || vault.repoId <= 0 ||
      !/^[1-9][0-9]*$/.test(vault.githubAccountId || '') ||
      !LOGIN.test(vault.githubLogin || '') || vault.repoName !== VAULT_REPO_NAME) {
    throw new VaultGitHubError('vault-not-connected', 409);
  }
  return vault;
}

export async function getVaultNoteClient(db, { ownerId, sessionVersion }, {
  env = process.env, fetcher = fetch, readOnly = false,
} = {}) {
  if (typeof readOnly !== 'boolean')
    throw new TypeError('Invalid Vault GitHub permission mode');
  // Account identity and repository mapping come only from a signed OgeNotes
  // session and MongoDB's account row. A request cannot choose a repo or token.
  const account = await db.collection('users').findOne(
    ownerMutationFilter(ownerId, { sessionVersion }), { projection: { vault: 1 } },
  );
  if (!account) throw new VaultGitHubError('session-expired', 401);
  const vault = validateVault(account.vault);
  const jwt = githubAppJwt({ env });
  const install = await vaultGithubRequest('/app/installations/' + vault.installationId + '/access_tokens', {
    token: jwt, method: 'POST', fetcher,
    body: { repository_ids: [vault.repoId],
      permissions: { contents: readOnly ? 'read' : 'write', metadata: 'read' } },
  });
  if (!install?.token || !Array.isArray(install.repositories) ||
      install.repositories.length !== 1 || install.repositories[0]?.id !== vault.repoId) {
    throw new VaultGitHubError('vault-repository-token-scope-failed');
  }
  const prefix = '/repos/' + vault.githubLogin + '/' + vault.repoName;
  const call = (path, options = {}) => {
    if (readOnly && (options.method || 'GET') !== 'GET')
      throw new TypeError('Read-only Vault installation cannot write');
    return vaultGithubRequest(prefix + path, {
      token: install.token, fetcher, ...options,
    });
  };
  const repo = await call('');
  if (repo.id !== vault.repoId || repo.private !== true ||
      String(repo.owner?.id) !== vault.githubAccountId ||
      repo.owner?.login !== vault.githubLogin) {
    throw new VaultGitHubError('vault-ownership-changed', 409);
  }
  if (typeof repo.default_branch !== 'string' || !/^[a-zA-Z0-9_.-]{1,100}$/.test(repo.default_branch) ||
      repo.default_branch.startsWith('-') || repo.default_branch.includes('..')) {
    throw new VaultGitHubError('vault-branch-unavailable', 409);
  }
  return { call, branch: repo.default_branch, vault };
}

function decodeGitHubFile(file, id) {
  if (!file || file.type !== 'file' || !SHA.test(file.sha || '') ||
      file.encoding !== 'base64' || typeof file.content !== 'string') {
    throw new VaultGitHubError('vault-note-corrupt');
  }
  const bytes = Buffer.from(file.content.replace(/\s/g, ''), 'base64');
  if (bytes.length > MAX_NOTE_BYTES) throw new VaultGitHubError('vault-note-too-large');
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw new VaultGitHubError('vault-note-corrupt'); }
  if (parsed?.format !== 'ogenotes-note' || parsed.version !== 1 || parsed.id !== id) {
    throw new VaultGitHubError('vault-note-corrupt');
  }
  try {
    // Validate and refuse malformed files rather than silently truncating them.
    const checked = validatedNote(parsed, { id, now: parsed.updatedAt });
    if (JSON.stringify(checked) !== JSON.stringify(parsed)) throw new Error('Invalid fields');
  } catch {
    throw new VaultGitHubError('vault-note-corrupt');
  }
  return { ...parsed, sha: file.sha };
}

export async function readVaultNote(client, id) {
  const path = noteFilePath(id);
  const file = await client.call('/contents/' + path + '?ref=' + encodeURIComponent(client.branch));
  return decodeGitHubFile(file, id.toLowerCase());
}

/**
 * Read one immutable GitHub blob by SHA rather than by branch path.
 * This keeps file-index scans pinned to their original GitHub tree even
 * while another client updates the branch. Callers may discard all content.
 */
export async function readVaultNoteBlob(client, id, sha) {
  const canonicalId = noteFilePath(id).slice(NOTE_PREFIX.length, -5);
  if (typeof sha !== 'string' || !SHA.test(sha))
    throw new TypeError('Invalid GitHub blob SHA');
  const blob = await client.call('/git/blobs/' + sha);
  return decodeGitHubFile({ ...blob, type: 'file', sha }, canonicalId);
}

export async function listVaultNotes(client) {
  let listing;
  try {
    listing = await client.call('/contents/notes?ref=' + encodeURIComponent(client.branch));
  } catch (error) {
    if (error instanceof VaultGitHubError && error.status === 404) return [];
    throw error;
  }
  if (!Array.isArray(listing) || listing.length > MAX_NOTES_PER_LIST ||
      listing.some((item) => item.type !== 'file' || !/^notes\/[0-9a-f-]{36}\.json$/.test(item.path) ||
        !NOTE_ID.test(item.name.slice(0, -5)))) {
    throw new VaultGitHubError('vault-note-directory-invalid', 409);
  }
  // Bounded fanout: GitHub's directory listing caps at 1,000 entries; limit\n  // the preview to 500 until cursor pagination and rate-limit-aware caching\n  // are implemented. Never silently return a truncated list.
  const result = [];
  for (let i = 0; i < listing.length; i += 5) {
    const batch = listing.slice(i, i + 5);
    result.push(...await Promise.all(batch.map((item) => readVaultNote(client, item.name.slice(0, -5)))));
  }
  return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Snapshot-pinned GitHub note pagination.
 *
 * Directory Contents API silently caps large directories at 1,000 entries.
 * Read a verified Git tree instead, then fetch only requested blob objects.
 * A cursor can never select another owner/repository because the client is
 * created only from the signed OgeNotes session and its vault mapping.
 */
const MAX_TREE_ENTRIES = 30000;
const MAX_PAGE_SIZE = 25;

function parsePageCursor(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string' || raw.length > 256 || !/^[a-zA-Z0-9_-]+$/.test(raw))
    throw new TypeError('Invalid vault page cursor');
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2 ||
        typeof parsed[0] !== 'string' || !SHA.test(parsed[0]) ||
        !Number.isSafeInteger(parsed[1]) || parsed[1] < 0 || parsed[1] > MAX_TREE_ENTRIES) {
      throw new TypeError('Invalid vault page cursor');
    }
    return { commitSha: parsed[0], offset: parsed[1] };
  } catch {
    throw new TypeError('Invalid vault page cursor');
  }
}

export async function listVaultNotePage(client, { cursor = null, limit = 20 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE)
    throw new TypeError('Invalid vault page size');
  const decoded = parsePageCursor(cursor);
  const ref = await client.call('/git/ref/heads/' + encodeURIComponent(client.branch));
  const commitSha = ref?.object?.sha;
  if (!SHA.test(commitSha || '')) throw new VaultGitHubError('vault-head-unavailable');
  if (decoded && decoded.commitSha !== commitSha)
    throw new VaultGitHubError('vault-page-stale', 409);
  const commit = await client.call('/git/commits/' + commitSha);
  if (!SHA.test(commit?.tree?.sha || ''))
    throw new VaultGitHubError('vault-tree-unavailable');
  const tree = await client.call('/git/trees/' + commit.tree.sha + '?recursive=1');
  if (!Array.isArray(tree?.tree) || tree.truncated === true ||
      tree.tree.length > MAX_TREE_ENTRIES) {
    throw new VaultGitHubError('vault-tree-too-large', 409);
  }
  const files = tree.tree.filter((item) =>
    item.type === 'blob' && typeof item.path === 'string' && item.path.startsWith(NOTE_PREFIX));
  if (files.some((item) =>
    typeof item.sha !== 'string' || !SHA.test(item.sha) ||
    !/^notes\/[0-9a-f-]{36}\.json$/.test(item.path) ||
    !NOTE_ID.test(item.path.slice(NOTE_PREFIX.length, -5)) ||
    (item.size !== undefined && (!Number.isSafeInteger(item.size) || item.size > MAX_NOTE_BYTES)))) {
    throw new VaultGitHubError('vault-note-directory-invalid', 409);
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const offset = decoded?.offset || 0;
  if (offset > files.length) throw new TypeError('Invalid vault page offset');
  const page = files.slice(offset, offset + limit);
  const notes = [];
  // Max five concurrent reads to constrain GitHub request bursts.
  for (let i = 0; i < page.length; i += 5) {
    const batch = page.slice(i, i + 5);
    const entries = await Promise.all(batch.map(async (item) => {
      const blob = await client.call('/git/blobs/' + item.sha);
      const id = item.path.slice(NOTE_PREFIX.length, -5);
      const note = decodeGitHubFile({ ...blob, type: 'file', sha: item.sha }, id);
      return note;
    }));
    notes.push(...entries);
  }
  const nextOffset = offset + page.length;
  const nextCursor = nextOffset < files.length
    ? Buffer.from(JSON.stringify([commitSha, nextOffset])).toString('base64url') : null;
  return {
    notes,
    nextCursor,
    total: files.length,
    snapshot: commitSha,
  };
}

export async function saveVaultNote(client, input, { id = randomUUID(), sha = null } = {}) {
  if (sha !== null && (typeof sha !== 'string' || !SHA.test(sha))) {
    throw new TypeError('A valid GitHub revision SHA is required for updates');
  }
  const current = sha ? await readVaultNote(client, id) : null;
  if (current && current.sha !== sha) throw new VaultGitHubError('vault-note-conflict', 409);
  const note = validatedNote({ ...input, ...(current ? { createdAt: current.createdAt } : {}) }, {
    id, now: new Date().toISOString(),
  });
  const path = noteFilePath(id);
  const payload = {
    message: (sha ? 'Update' : 'Create') + ' OgeNotes note ' + note.id,
    content: Buffer.from(JSON.stringify(note, null, 2) + '\n').toString('base64'),
    branch: client.branch,
    ...(sha ? { sha } : {}),
  };
  const response = await client.call('/contents/' + path, { method: 'PUT', body: payload });
  const newSha = response?.content?.sha;
  if (!SHA.test(newSha || '')) throw new VaultGitHubError('vault-write-unconfirmed');
  // Do not claim success on an unverified GitHub write.
  let verified;
  try {
    verified = await readVaultNote(client, id);
  } catch {
    throw new VaultGitHubError('vault-write-unconfirmed');
  }
  if (verified.sha !== newSha || verified.answer !== note.answer ||
      verified.heading !== note.heading || verified.subjectId !== note.subjectId ||
      verified.favorite !== note.favorite || verified.updatedAt !== note.updatedAt ||
      JSON.stringify(verified.tags) !== JSON.stringify(note.tags)) {
    throw new VaultGitHubError('vault-write-unconfirmed');
  }
  return verified;
}

export async function deleteVaultNote(client, id, sha) {
  if (typeof sha !== 'string' || !SHA.test(sha)) throw new TypeError('Missing GitHub revision SHA');
  const current = await readVaultNote(client, id);
  if (current.sha !== sha) throw new VaultGitHubError('vault-note-conflict', 409);
  await client.call('/contents/' + noteFilePath(id), {
    method: 'DELETE',
    body: { message: 'Delete OgeNotes note ' + id, sha, branch: client.branch },
  });
  // Git history retains the deleted content. Confirm current branch no longer has the note.
  try {
    await readVaultNote(client, id);
  } catch (error) {
    if (error instanceof VaultGitHubError && error.status === 404) return { deleted: id };
    throw error;
  }
  throw new VaultGitHubError('vault-delete-unconfirmed');
}
