import { randomUUID } from 'node:crypto';
import { noteFilePath, validatedNote, readVaultNote, MAX_VAULT_BATCH_ITEMS } from './oge-vault-notes.js';
import { VaultGitHubError } from './oge-vault-github.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/i;

/**
 * A single atomic Git commit covering multiple Notes.
 *
 * The Git reference is moved with force:false, so a competing commit makes
 * the ref update non-fast-forward and is reported as a conflict. Each modified
 * file must also match its expected blob SHA at the beginning of the operation.
 *
 * There is deliberately no MongoDB note-content cache or pending-write queue.
 */
export async function commitVaultNoteBatch(client, operations, {
  now = new Date().toISOString(), idFactory = randomUUID,
  expectedHead = null, preserveImportTimestamps = false,
  commitMessage = null,
} = {}) {
  if (!Array.isArray(operations) || operations.length < 1 ||
      operations.length > MAX_VAULT_BATCH_ITEMS) {
    throw new TypeError('Invalid GitHub note batch size');
  }
  if (commitMessage !== null && (expectedHead === null ||
      typeof commitMessage !== 'string' ||
      !/^Restore OgeNotes backup [a-f0-9]{64}$/.test(commitMessage)))
    throw new TypeError('Invalid approved backup commit marker');
  const prepared = [];
  const seen = new Set();
  for (const raw of operations) {
    if (!raw || !['create', 'update', 'delete'].includes(raw.action)) {
      throw new TypeError('Unsupported GitHub note operation');
    }
    const id = raw.action === 'create' ? (raw.id ?? idFactory()) : raw.id;
    const path = noteFilePath(id);
    if (seen.has(path)) throw new TypeError('Duplicate note in batch');
    seen.add(path);
    const expectedSha = raw.action === 'create' ? null : raw.sha;
    if (expectedSha !== null && (typeof expectedSha !== 'string' || !SHA.test(expectedSha))) {
      throw new TypeError('Missing GitHub note revision SHA');
    }
    prepared.push({ action: raw.action, id: id.toLowerCase(), path, expectedSha, data: raw.note });
  }

  // GitHub uses a singular /git/ref/ endpoint for GET and the plural
  // /git/refs/ endpoint for PATCH. Using the GET path for PATCH returns
  // 404 and makes an otherwise valid Notes Save look unconfirmed.
  const readRefPath = '/git/ref/heads/' + encodeURIComponent(client.branch);
  const updateRefPath = '/git/refs/heads/' + encodeURIComponent(client.branch);
  const ref = await client.call(readRefPath);
  const oldHead = ref?.object?.sha;
  if (!SHA.test(oldHead || '')) throw new VaultGitHubError('vault-head-unavailable');
  // An approved backup plan is bound to the exact GitHub HEAD the owner saw.
  // Ordinary Notes saves pass no expectedHead and remain unchanged.
  if (expectedHead !== null && (typeof expectedHead !== 'string' || !SHA.test(expectedHead)))
    throw new TypeError('Invalid approved GitHub HEAD');
  if (expectedHead !== null && oldHead !== expectedHead)
    throw new VaultGitHubError('vault-import-target-head-changed', 409);
  const previousCommit = await client.call('/git/commits/' + oldHead);
  if (!SHA.test(previousCommit?.tree?.sha || '')) throw new VaultGitHubError('vault-tree-unavailable');
  const directory = await client.call('/git/trees/' + previousCommit.tree.sha + '?recursive=1');
  if (!Array.isArray(directory.tree) || directory.truncated === true ||
      directory.tree.length > 30000) {
    throw new VaultGitHubError('vault-tree-too-large', 409);
  }
  const files = new Map(directory.tree.filter((item) =>
    item.type === 'blob' && typeof item.path === 'string' && item.path.startsWith('notes/'),
  ).map((item) => [item.path, item.sha]));
  const changes = [];
  for (const item of prepared) {
    const actualSha = files.get(item.path) || null;
    if (actualSha !== item.expectedSha) {
      throw new VaultGitHubError('vault-note-conflict', 409);
    }
    if (item.action === 'delete') {
      changes.push({ path: item.path, mode: '100644', type: 'blob', sha: null });
      continue;
    }
    let existing = null;
    if (item.action === 'update') {
      existing = await readVaultNote(client, item.id);
      if (existing.sha !== actualSha) throw new VaultGitHubError('vault-note-conflict', 409);
    }
    const note = validatedNote({
      ...item.data,
      ...(existing ? { createdAt: existing.createdAt } : {}),
    }, { id: item.id,
      now: preserveImportTimestamps && item.action === 'create'
        ? item.data?.updatedAt : now,
    });
    changes.push({
      path: item.path, mode: '100644', type: 'blob',
      content: JSON.stringify(note, null, 2) + '\n',
    });
  }

  const tree = await client.call('/git/trees', {
    method: 'POST', body: { base_tree: previousCommit.tree.sha, tree: changes },
  });
  if (!SHA.test(tree?.sha || '')) throw new VaultGitHubError('vault-tree-unavailable');
  const commit = await client.call('/git/commits', {
    method: 'POST', body: {
      message: commitMessage || 'Sync ' + operations.length + ' OgeNotes note changes',
      tree: tree.sha, parents: [oldHead],
    },
  });
  if (!SHA.test(commit?.sha || '')) throw new VaultGitHubError('vault-commit-unavailable');
  let patchFailure = null;
  try {
    await client.call(updateRefPath, { method: 'PATCH', body: { sha: commit.sha, force: false } });
  } catch (error) {
    // A 409/422 or a timeout can happen after GitHub actually updates HEAD.
    // Recheck first: never blindly retry the PATCH or create another commit.
    patchFailure = error;
  }
  let updatedRef;
  try { updatedRef = await client.call(readRefPath); }
  catch { throw new VaultGitHubError('vault-commit-unconfirmed', 503); }
  if (updatedRef?.object?.sha !== commit.sha) {
    if (patchFailure instanceof VaultGitHubError &&
        [409, 422].includes(patchFailure.status))
      throw new VaultGitHubError('vault-note-conflict', 409);
    throw new VaultGitHubError('vault-commit-unconfirmed', 503);
  }
  // Only a verified HEAD, tree and commit ancestry may confirm Save.
  // The final per-note checks below still ensure exact GitHub content.
  let committed;
  try { committed = await client.call('/git/commits/' + commit.sha); }
  catch { throw new VaultGitHubError('vault-commit-unconfirmed', 503); }
  if ((commitMessage !== null && committed?.message !== commitMessage) ||
      committed?.tree?.sha !== tree.sha ||
      !Array.isArray(committed?.parents) ||
      !committed.parents.some((parent) =>
        (typeof parent === 'string' ? parent : parent?.sha) === oldHead))
    throw new VaultGitHubError('vault-commit-unconfirmed', 503);
  const results = [];
  for (const item of prepared) {
    if (item.action === 'delete') {
      try {
        await readVaultNote(client, item.id);
      } catch (error) {
        if (error instanceof VaultGitHubError && error.status === 404) {
          results.push({ action: 'delete', id: item.id, deleted: true });
          continue;
        }
        throw new VaultGitHubError('vault-commit-unconfirmed');
      }
      throw new VaultGitHubError('vault-commit-unconfirmed');
    }
    const note = await readVaultNote(client, item.id).catch(() => {
      throw new VaultGitHubError('vault-commit-unconfirmed');
    });
    const expected = changes.find((change) => change.path === item.path);
    if (JSON.stringify({
      format: note.format, version: note.version, id: note.id,
      subjectId: note.subjectId, heading: note.heading, answer: note.answer,
      tags: note.tags, favorite: note.favorite,
      updatedAt: note.updatedAt, createdAt: note.createdAt,
    }) !== JSON.stringify(JSON.parse(expected.content))) {
      throw new VaultGitHubError('vault-commit-unconfirmed');
    }
    results.push({ action: item.action, ...note });
  }
  return { commitSha: commit.sha, results };
}
