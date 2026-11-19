import { randomUUID } from 'node:crypto';
import { VaultGitHubError } from './oge-vault-github.js';
import { normalizeSavedLink } from './saved-links.js';

// Store a small bookmark collection as a single GitHub versioned JSON file.
// A Contents API SHA is the optimistic-concurrency token for every mutation.
// No bookmark titles, URLs or descriptions are written to MongoDB in this mode.
export const VAULT_SAVED_LINKS_PATH = 'links/saved-links.json';
const SHA = /^[a-f0-9]{40}$/i;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const MAX_LINKS = 500;
const MAX_BYTES = 900_000;
const fail = (code, status = 409) => new VaultGitHubError(code, status);

function requireLinkId(id) {
  if (typeof id !== 'string' || !UUID.test(id))
    throw new TypeError('Invalid saved link ID');
  return id.toLowerCase();
}

function storedLink(link, order) {
  const id = requireLinkId(link?.id);
  const normalized = normalizeSavedLink(link);
  if (normalized.error) throw fail('vault-links-invalid-file');
  if (!Number.isSafeInteger(order) || order < 0 || order >= MAX_LINKS ||
      typeof link.createdAt !== 'string' || !Number.isFinite(Date.parse(link.createdAt)) ||
      typeof link.updatedAt !== 'string' || !Number.isFinite(Date.parse(link.updatedAt))) {
    throw fail('vault-links-invalid-file');
  }
  return {
    id, ...normalized.value, order,
    createdAt: link.createdAt, updatedAt: link.updatedAt,
  };
}

function canonicalDocument(links, updatedAt) {
  return { format: 'oge-saved-links', version: 1, updatedAt, links };
}

export function parseVaultSavedLinks(file) {
  if (file?.type !== 'file' || typeof file.sha !== 'string' || !SHA.test(file.sha) ||
      file.encoding !== 'base64' || typeof file.content !== 'string')
    throw fail('vault-links-invalid-file');
  let doc;
  try {
    const bytes = Buffer.from(file.content.replace(/\s/g, ''), 'base64');
    if (bytes.length > MAX_BYTES) throw new Error('oversized');
    doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw fail('vault-links-invalid-file');
  }
  if (doc?.format !== 'oge-saved-links' || doc.version !== 1 ||
      !Array.isArray(doc.links) || doc.links.length > MAX_LINKS ||
      typeof doc.updatedAt !== 'string' || !Number.isFinite(Date.parse(doc.updatedAt)))
    throw fail('vault-links-invalid-file');
  const ids = new Set();
  const links = doc.links.map((raw, order) => {
    const item = storedLink(raw, order);
    if (raw.order !== order || ids.has(item.id))
      throw fail('vault-links-invalid-file');
    ids.add(item.id);
    return item;
  });
  return { sha: file.sha, links };
}

export async function readVaultSavedLinks(client) {
  let file;
  try {
    file = await client.call('/contents/' + VAULT_SAVED_LINKS_PATH +
      '?ref=' + encodeURIComponent(client.branch));
  } catch (error) {
    if (error instanceof VaultGitHubError && error.status === 404)
      return { sha: null, links: [] };
    throw error;
  }
  return parseVaultSavedLinks(file);
}

async function writeVaultSavedLinks(client, before, links, action) {
  if (!Array.isArray(links) || links.length > MAX_LINKS)
    throw fail('vault-links-limit-reached');
  const now = new Date().toISOString();
  const body = Buffer.from(JSON.stringify(canonicalDocument(links, now), null, 2) + '\n');
  if (body.length > MAX_BYTES)
    throw fail('vault-links-file-too-large', 413);

  // Do not retry an uncertain GitHub write: the SHA or browser state may have
  // changed. First confirm on the server that the committed file matches.
  const result = await client.call('/contents/' + VAULT_SAVED_LINKS_PATH, {
    method: 'PUT',
    body: {
      message: action + ' Oge Saved Links',
      content: body.toString('base64'),
      branch: client.branch,
      ...(before.sha ? { sha: before.sha } : {}),
    },
  });
  const sha = result?.content?.sha;
  if (typeof sha !== 'string' || !SHA.test(sha))
    throw fail('vault-links-write-unconfirmed', 503);
  let observed;
  try { observed = await readVaultSavedLinks(client); }
  catch { throw fail('vault-links-write-unconfirmed', 503); }
  if (observed.sha !== sha ||
      JSON.stringify(observed.links) !== JSON.stringify(links))
    throw fail('vault-links-write-unconfirmed', 503);
  return observed;
}

export async function createVaultSavedLink(client, input, { id = randomUUID() } = {}) {
  const linkId = requireLinkId(id);
  const normalized = normalizeSavedLink(input);
  if (normalized.error) throw new TypeError(normalized.error);
  const before = await readVaultSavedLinks(client);
  const existing = before.links.find(link => link.id === linkId);
  if (existing) {
    // An acknowledged POST response may have been lost. Retrying the same
    // client-generated UUID with the same content does not create a duplicate.
    if (JSON.stringify(normalized.value) === JSON.stringify({
      title: existing.title, url: existing.url, description: existing.description,
      category: existing.category, tags: existing.tags,
    })) return existing;
    throw fail('vault-links-id-conflict');
  }
  if (before.links.length === MAX_LINKS)
    throw fail('vault-links-limit-reached');
  const now = new Date().toISOString();
  const item = { id: linkId, ...normalized.value, order: before.links.length,
    createdAt: now, updatedAt: now };
  await writeVaultSavedLinks(client, before, [...before.links, item], 'Create');
  return item;
}

export async function updateVaultSavedLink(client, id, input) {
  const key = requireLinkId(id);
  const normalized = normalizeSavedLink(input);
  if (normalized.error) throw new TypeError(normalized.error);
  const before = await readVaultSavedLinks(client);
  const index = before.links.findIndex(item => item.id === key);
  if (index === -1) throw fail('vault-links-not-found', 404);
  const old = before.links[index];
  const updated = { ...old, ...normalized.value, updatedAt: new Date().toISOString() };
  await writeVaultSavedLinks(client, before,
    before.links.map(link => link.id === key ? updated : link), 'Update');
  return updated;
}

export async function deleteVaultSavedLink(client, id) {
  const key = requireLinkId(id);
  const before = await readVaultSavedLinks(client);
  if (!before.links.some(link => link.id === key))
    throw fail('vault-links-not-found', 404);
  await writeVaultSavedLinks(client, before,
    before.links.filter(link => link.id !== key)
      .map((link, order) => ({ ...link, order })), 'Delete');
  return { deleted: key };
}

export async function reorderVaultSavedLinks(client, ids) {
  if (!Array.isArray(ids) || ids.length > MAX_LINKS ||
      ids.some(id => typeof id !== 'string' || !UUID.test(id)) ||
      new Set(ids.map(id => id.toLowerCase())).size !== ids.length)
    throw new TypeError('Invalid saved links order');
  const before = await readVaultSavedLinks(client);
  if (ids.length !== before.links.length)
    throw fail('vault-links-order-changed');
  const byId = new Map(before.links.map(link => [link.id, link]));
  if (ids.some(id => !byId.has(id.toLowerCase())))
    throw fail('vault-links-order-changed');
  const now = new Date().toISOString();
  const reordered = ids.map((id, order) => ({
    ...byId.get(id.toLowerCase()), order, updatedAt: now,
  }));
  await writeVaultSavedLinks(client, before, reordered, 'Reorder');
  return { reordered: reordered.length };
}
