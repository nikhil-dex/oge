import { VaultGitHubError } from './oge-vault-github.js';
import { noteFilePath, MAX_VAULT_NOTE_BYTES } from './oge-vault-notes.js';
import { standaloneCapturePath } from './oge-vault-standalone-captures.js';
import {
  verifyVaultCurrentResourcesArchive, MAX_VAULT_RESOURCE_BACKUP_BYTES,
} from './oge-vault-backup-current-resources.js';

/**
 * E6/M74: advisory-only target conflict inspection for M73 archives.
 * The source JSON and its hashes are UNTRUSTED. Do not make an archive
 * digest, a target HEAD or a "create candidate" into write authorization.
 * No GitHub writes, MongoDB mutations, local staging files or content echo.
 */
const SHA = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const TREE_MAX = 30000;
const BATCH = 100;
const PREVIEW = 18;
const KINDS = Object.freeze([
  { key: 'notes', label: 'notes', prefix: 'notes/', max: 30000,
    size: MAX_VAULT_NOTE_BYTES },
  { key: 'quickNotes', label: 'quick-notes', prefix: 'quick-notes/',
    max: 300, size: 32 * 1024 },
  { key: 'airNotes', label: 'airnotes', prefix: 'airnotes/',
    max: 300, size: 32 * 1024 },
]);
const fail = (reason, status = 409) => new VaultGitHubError(reason, status);

function canonicalPath(kind, id) {
  try {
    return kind.key === 'notes' ? noteFilePath(id) :
      standaloneCapturePath(kind.label, id);
  } catch {
    throw fail('vault-resources-restore-target-invalid');
  }
}

/**
 * Immutable TARGET tree inventory. We never skip a suspicious path under
 * a reserved resource namespace. The archive itself does not select this
 * repository, GitHub tree, owner, branch, token or any resource path.
 */
function scanTargetTree(entries) {
  if (!Array.isArray(entries) || entries.length > TREE_MAX)
    throw fail('vault-resources-restore-target-incomplete');
  const found = Object.fromEntries(KINDS.map((kind) => [kind.key, new Set()]));
  const seen = new Set();
  for (const item of entries) {
    if (typeof item?.path !== 'string' || !item.path)
      throw fail('vault-resources-restore-target-invalid');
    const root = KINDS.find((kind) => item.path === kind.prefix.slice(0, -1));
    if (root) {
      if (item.type !== 'tree' ||
          (item.mode !== undefined && item.mode !== '040000') ||
          seen.has(item.path))
        throw fail('vault-resources-restore-target-invalid');
      seen.add(item.path);
      continue;
    }
    const kind = KINDS.find((value) => item.path.startsWith(value.prefix));
    if (!kind) continue;
    const id = item.path.endsWith('.json') ?
      item.path.slice(kind.prefix.length, -5) : '';
    if (!UUID.test(id) || canonicalPath(kind, id) !== item.path ||
        item.type !== 'blob' ||
        (item.mode !== undefined && item.mode !== '100644') ||
        !SHA.test(item.sha || '') ||
        (item.size !== undefined &&
          (!Number.isSafeInteger(item.size) || item.size < 0 ||
            item.size > kind.size)) || seen.has(item.path))
      throw fail('vault-resources-restore-target-invalid');
    seen.add(item.path);
    found[kind.key].add(id);
  }
  for (const kind of KINDS) {
    if (found[kind.key].size > kind.max)
      throw fail('vault-resources-restore-target-too-large', 413);
  }
  return found;
}

async function readTargetIndex(client) {
  if (!client || typeof client.call !== 'function' ||
      client.readOnly !== true || typeof client.branch !== 'string' ||
      !/^[a-zA-Z0-9_.-]{1,100}$/.test(client.branch) ||
      client.branch.startsWith('-') || client.branch.includes('..') ||
      !Number.isSafeInteger(client.vault?.repoId) || client.vault.repoId < 1)
    throw new TypeError('Signed read-only private Vault target required');
  const refPath = '/git/ref/heads/' + encodeURIComponent(client.branch);
  const head = (await client.call(refPath))?.object?.sha;
  if (!SHA.test(head || ''))
    throw fail('vault-resources-restore-head-unavailable', 503);
  const commit = await client.call('/git/commits/' + head);
  if (!SHA.test(commit?.tree?.sha || ''))
    throw fail('vault-resources-restore-tree-unavailable', 503);
  const tree = await client.call(
    '/git/trees/' + commit.tree.sha + '?recursive=1');
  if (tree?.truncated === true)
    throw fail('vault-resources-restore-target-incomplete');
  return {
    head, refPath, files: scanTargetTree(tree?.tree),
  };
}

async function checkOwner(ownerVerifier) {
  if (await ownerVerifier() !== true)
    throw fail('vault-resources-restore-owner-changed');
}
async function verifySubjects(ids, subjectVerifier) {
  for (let index = 0; index < ids.length; index += BATCH) {
    if (await subjectVerifier(ids.slice(index, index + BATCH)) !== true)
      throw fail('vault-resources-restore-subject-unverified');
  }
}
async function checkDrafts(kind, records, pendingDraftIds) {
  const found = new Set();
  for (let index = 0; index < records.length; index += BATCH) {
    const ids = records.slice(index, index + BATCH).map((r) => r.id);
    const allowed = new Set(ids);
    const rows = await pendingDraftIds(kind.label, ids);
    if (!Array.isArray(rows) || rows.length > ids.length ||
        rows.some((id) => typeof id !== 'string' || !allowed.has(id) ||
          found.has(id)) || new Set(rows).size !== rows.length)
      throw fail('vault-resources-restore-draft-check-invalid');
    rows.forEach((id) => found.add(id));
  }
  return found;
}

/**
 * Validate the entire untrusted SOURCE first. Only then check ownership,
 * target subjects, immutable Git HEAD/tree and scoped temporary draft IDs.
 * No source note title, body, tags, contents or blob SHA is returned.
 *
 * "create-candidate" means not found in this READ-ONLY snapshot only.
 * It is neither an import plan token nor a permission to write later.
 * The caller must independently recheck signed session/repo incarnation
 * after this function returns and before exposing even the ID preview.
 */
export async function planVaultCurrentResourcesRestoreReadOnly(client, archive, {
  subjectVerifier, pendingDraftIds, ownerVerifier,
  maxBytes = MAX_VAULT_RESOURCE_BACKUP_BYTES,
} = {}) {
  if (typeof subjectVerifier !== 'function' ||
      typeof pendingDraftIds !== 'function' ||
      typeof ownerVerifier !== 'function')
    throw new TypeError('Signed owner, subject and draft verifiers required');

  // Must run before ANY target Github/DB reads; a self-consistent checksum
  // still does NOT authenticate the source/author of this supplied JSON.
  const source = verifyVaultCurrentResourcesArchive(archive, { maxBytes });
  await checkOwner(ownerVerifier);
  const subjects = [...new Set(archive.notes.map((note) => note.subjectId))].sort();
  await verifySubjects(subjects, subjectVerifier);

  const target = await readTargetIndex(client);
  const pending = {};
  for (const kind of KINDS)
    pending[kind.key] = await checkDrafts(
      kind, archive[kind.key], pendingDraftIds);

  if ((await client.call(target.refPath))?.object?.sha !== target.head)
    throw fail('vault-resources-restore-target-head-changed');
  await checkOwner(ownerVerifier);

  const summary = {
    total: 0, createCandidates: 0,
    existingConflicts: 0, draftConflicts: 0,
  };
  const byKind = {};
  const preview = [];
  for (const kind of KINDS) {
    const counts = {
      total: archive[kind.key].length, createCandidates: 0,
      existingConflicts: 0, draftConflicts: 0,
    };
    for (const { id } of archive[kind.key]) {
      const outcome = pending[kind.key].has(id) ?
        'draft-conflict' : target.files[kind.key].has(id) ?
          'existing-resource-conflict' : 'create-candidate';
      if (outcome === 'draft-conflict') {
        counts.draftConflicts++; summary.draftConflicts++;
      } else if (outcome === 'existing-resource-conflict') {
        counts.existingConflicts++; summary.existingConflicts++;
      } else {
        counts.createCandidates++; summary.createCandidates++;
      }
      summary.total++;
      if (preview.length < PREVIEW) preview.push({
        kind: kind.label, id, outcome,
      });
    }
    byKind[kind.key] = counts;
  }
  return {
    format: 'oge-vault-current-resources-restore-plan',
    version: 1,
    sourceSnapshot: source.snapshot,
    sourceInventorySha256: source.inventorySha256,
    targetHead: target.head,
    summary, byKind, preview,
    previewTruncated: summary.total > PREVIEW,
    readOnly: true, advisoryOnly: true,
    sourceIntegrityInspected: true,
    sourceGitHubIdentityAuthenticated: false,
    sourceShaTrustedAsAuthorization: false,
    sourcePrivateTextReturned: false,
    sourceNoteBlobProvenanceVerified: false,
    fullAccountRecoveryReady: false,
    requiresIndependentOwnerApproval: true,
    needsFreshTargetAndDraftRecheckBeforeAnyWrite: true,
    canCommit: false, canRestore: false,
    changesEncryptedDrafts: false,
    writesToGitHub: false, writesToMongo: false,
  };
}
