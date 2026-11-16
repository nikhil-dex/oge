import { createHash } from 'node:crypto';
import {
  verifyVaultCurrentResourcesArchive, MAX_VAULT_RESOURCE_BACKUP_BYTES,
} from './oge-vault-backup-current-resources.js';
import {
  planVaultCurrentResourcesRestoreReadOnly,
} from './oge-vault-backup-current-resources-plan.js';
import {
  standaloneCapturePath, validatedStandaloneCapture,
  readVaultStandaloneBlob,
} from './oge-vault-standalone-captures.js';
import { VaultGitHubError } from './oge-vault-github.js';

/**
 * E7/M75: ONE create-only batch of ONE standalone type (Quick Notes OR
 * AirNotes), max 12, from a complete untrusted M73 archive.
 *
 * No HTTP call here. All writes require an external owner import fence,
 * durable markGitHubWriteAttempt, independent signed owner verifier,
 * read-only provider token for the fresh M74 plan and a separate
 * repository-scoped write token. Never retry an ambiguous ref mutation.
 *
 * A checksum/fingerprint is NOT provenance or cryptographic approval:
 * the user must independently trust the imported source JSON.
 */
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const KINDS = Object.freeze({
  'quick-notes': { key: 'quickNotes', max: 300 },
  airnotes: { key: 'airNotes', max: 300 },
});
const PREPARE = 'PREPARE_SELECTED_STANDALONE_CREATE_ONLY';
const APPROVE = 'COMMIT_SELECTED_STANDALONE_CREATE_ONLY';
const MAX_SELECTED = 12;
const fail = (reason, status = 409) => new VaultGitHubError(reason, status);
const hash = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const sameKeys = (value, fields) =>
  value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...fields].sort().join(',');

export function validateStandaloneRestoreSelection(request, { commit = false } = {}) {
  const fields = ['archive', 'kind', 'selectedIds',
    'expectedTargetHead', 'confirmation',
    ...(commit ? ['expectedSelectionFingerprint'] : [])];
  if (!sameKeys(request, fields) ||
      request.confirmation !== (commit ? APPROVE : PREPARE) ||
      !Object.hasOwn(KINDS, request.kind) ||
      !SHA.test(request.expectedTargetHead || '') ||
      !Array.isArray(request.selectedIds) ||
      request.selectedIds.length < 1 ||
      request.selectedIds.length > MAX_SELECTED ||
      request.selectedIds.some((id) => !UUID.test(id || '')) ||
      new Set(request.selectedIds).size !== request.selectedIds.length ||
      (commit && !DIGEST.test(request.expectedSelectionFingerprint || '')))
    throw fail('vault-standalone-restore-selection-invalid', 400);
  const proof = verifyVaultCurrentResourcesArchive(request.archive);
  const { key } = KINDS[request.kind];
  const rows = new Map(request.archive[key].map((entry) => [entry.id, entry]));
  if (request.selectedIds.some((id) => !rows.has(id)))
    throw fail('vault-standalone-restore-unrecognized-id', 400);
  return { kind: request.kind, key, selectedIds: request.selectedIds,
    selected: request.selectedIds.map((id) => rows.get(id)),
    expectedTargetHead: request.expectedTargetHead,
    sourceSnapshot: proof.snapshot, sourceArchiveSha256: proof.archiveSha256 };
}

function selectionFingerprint(approved) {
  return hash('oge-vault-standalone-restore-selection-v1\n' +
    JSON.stringify({
      kind: approved.kind, selectedIds: approved.selectedIds,
      selected: approved.selected,
      expectedTargetHead: approved.expectedTargetHead,
      sourceSnapshot: approved.sourceSnapshot,
      sourceArchiveSha256: approved.sourceArchiveSha256,
    }));
}
function commitMarker(approved, fingerprint) {
  // Import fence's approved marker schema cannot carry note text or type:
  // encode both in a content-free SHA-256 marker, with selected IDs in the
  // durable owner-row metadata. Restrict each batch to ONE standalone kind.
  return 'Restore OgeNotes backup ' + hash(
    'standalone-create-only-v1:' + approved.kind + ':' + fingerprint);
}

async function currentIntent(readClient, request, safeguards, {
  commit = false,
} = {}) {
  const selection = validateStandaloneRestoreSelection(request, { commit });
  if (typeof safeguards?.ownerVerifier !== 'function' ||
      typeof safeguards?.subjectVerifier !== 'function' ||
      typeof safeguards?.pendingDraftIds !== 'function')
    throw new TypeError('Signed owner, subject and draft verification required');

  const plan = await planVaultCurrentResourcesRestoreReadOnly(
    readClient, request.archive, safeguards);
  if (plan.targetHead !== selection.expectedTargetHead)
    throw fail('vault-standalone-restore-target-head-changed');
  if (plan.sourceInventorySha256 !== request.archive.inventorySha256 ||
      !plan.sourceIntegrityInspected)
    throw fail('vault-standalone-restore-source-invalid');
  // The M74 UUID preview intentionally shows at most 18, so a fresh
  // full-target outcome check must NOT infer selected safety from preview.
  // A "create candidate" exists only if absent from the current tree AND
  // neither typed draft collection has that ID; M74 reports full counts,
  // but not every ID. A dedicated selection-check callback below is
  // required to prove every chosen ID rather than trusting only totals.
  if (typeof safeguards.selectedIdsAreCreateCandidates !== 'function' ||
      await safeguards.selectedIdsAreCreateCandidates(
        selection.kind, selection.selectedIds, plan.targetHead) !== true)
    throw fail('vault-standalone-restore-selected-conflict');

  const fingerprint = selectionFingerprint(selection);
  if (commit && fingerprint !== request.expectedSelectionFingerprint)
    throw fail('vault-standalone-restore-intent-changed');
  return { selection, plan, fingerprint };
}

/** Prepare a content-free candidate fingerprint, WITHOUT any GitHub writer. */
export async function prepareVaultStandaloneRestoreIntent(
  readClient, request, safeguards,
) {
  const { selection, plan, fingerprint } =
    await currentIntent(readClient, request, safeguards);
  return {
    format: 'oge-vault-standalone-create-only-intent', version: 1,
    kind: selection.kind, selectedIds: selection.selectedIds,
    selectedCount: selection.selectedIds.length,
    sourceSnapshot: selection.sourceSnapshot,
    sourceArchiveSha256: selection.sourceArchiveSha256,
    targetHead: plan.targetHead,
    selectionFingerprint: fingerprint,
    requiresSeparateOwnerApproval: true,
    sourceGitHubIdentityAuthenticated: false,
    sourceDigestIsAuthorization: false,
    canCommit: false, canRestore: false,
    futureCommitRequiresFreshPlan: true,
    readOnly: true, noPrivateContentReturned: true,
  };
}

function assertWriteClient(readClient, writeClient) {
  if (writeClient?.readOnly === true ||
      typeof writeClient?.call !== 'function' ||
      readClient?.readOnly !== true ||
      writeClient.branch !== readClient.branch ||
      writeClient.vault?.repoId !== readClient.vault?.repoId ||
      writeClient.vault?.installationId !== readClient.vault?.installationId ||
      writeClient.vault?.githubAccountId !== readClient.vault?.githubAccountId ||
      writeClient.vault?.githubLogin !== readClient.vault?.githubLogin ||
      writeClient.vault?.repoName !== readClient.vault?.repoName)
    throw new TypeError('Mismatched signed read/write private Vault clients');
}

/**
 * Under the EXCLUSIVE owner lock, independently recalculate the full
 * target/draft plan and the owner's exact selection fingerprint.
 * Mark potential write durably BEFORE the first GitHub POST. A failure
 * after that mark retains the external owner import quarantine.
 */
export async function executeApprovedStandaloneRestoreBatch(
  readClient, writeClient, request, safeguards, {
    markGitHubWriteAttempt, maxBytes = MAX_VAULT_RESOURCE_BACKUP_BYTES,
    batchWriter = commitCreateOnlyStandaloneRestores,
  } = {},
) {
  if (typeof markGitHubWriteAttempt !== 'function' ||
      typeof batchWriter !== 'function')
    throw new TypeError('Durable owner import fence and batch writer required');
  assertWriteClient(readClient, writeClient);
  const { selection, fingerprint, plan } =
    await currentIntent(readClient, request, safeguards, { commit: true });
  // All safety claims must be re-established from the write-scoped GitHub
  // token before attempting changes; the owner can't pick a different repo.
  if (!await safeguards.ownerVerifier())
    throw fail('vault-standalone-restore-owner-changed');
  // The writer re-scans target HEAD/tree, ensures create-only in *kind*,
  // ensures the original HEAD, verifies immutable new blobs and Git commit.
  // No sensitive text is included in MongoDB owner lock or commit message.
  const marker = commitMarker(selection, fingerprint);
  await markGitHubWriteAttempt(marker, {
    expectedHead: selection.expectedTargetHead,
    selectedIds: selection.selectedIds,
  });
  if (!await safeguards.ownerVerifier())
    throw fail('vault-standalone-restore-owner-changed-after-marker');

  const result = await batchWriter(writeClient, selection.kind,
    selection.selected, {
      expectedHead: selection.expectedTargetHead,
      commitMessage: marker, maxBytes,
    });
  if (!SHA.test(result?.commitSha || '') ||
      !Array.isArray(result?.records) ||
      result.records.length !== selection.selected.length)
    throw fail('vault-standalone-restore-write-unconfirmed', 503);
  for (let i = 0; i < selection.selected.length; i++) {
    if (result.records[i]?.id !== selection.selected[i].id ||
        !SHA.test(result.records[i]?.sha || ''))
      throw fail('vault-standalone-restore-write-unconfirmed', 503);
  }
  return {
    format: 'oge-vault-standalone-restore-batch-result',
    version: 1, kind: selection.kind,
    importedIds: selection.selectedIds,
    importedCount: selection.selectedIds.length,
    commitSha: result.commitSha,
    sourceSnapshot: selection.sourceSnapshot,
    targetHeadBefore: plan.targetHead,
    selectionFingerprint: fingerprint,
    overwritePerformed: false,
    encryptedDraftsChanged: false,
    singleBatchOnly: true,
    nextBatchAutomaticallyStarted: false,
    sourceGitHubIdentityAuthenticated: false,
    noPermanentMongoContent: true,
  };
}

/**
 * Single exact GitHub CAS ref update, no more than 12 create-only files.
 * Caller already holds owner-wide import fence with pending-draft checks
 * and durable uncertainty marker. This function has NO automatic replay.
 */
export async function commitCreateOnlyStandaloneRestores(client, kind, source, {
  expectedHead, commitMessage, maxBytes = MAX_VAULT_RESOURCE_BACKUP_BYTES,
} = {}) {
  if (!Object.hasOwn(KINDS, kind) ||
      client?.readOnly === true || typeof client?.call !== 'function' ||
      !SHA.test(expectedHead || '') ||
      !/^Restore OgeNotes backup [a-f0-9]{64}$/.test(commitMessage || '') ||
      !Array.isArray(source) || source.length < 1 ||
      source.length > MAX_SELECTED ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1024 || maxBytes > MAX_VAULT_RESOURCE_BACKUP_BYTES)
    throw new TypeError('Invalid fenced create-only standalone restore batch');
  const seen = new Set();
  const records = source.map((row) => {
    const id = row?.id;
    if (!UUID.test(id || '') || seen.has(id)) throw new TypeError('Invalid duplicate restore ID');
    seen.add(id);
    const restored = validatedStandaloneCapture(kind, {
      content: row.content, createdAt: row.createdAt,
    }, { id, now: row.updatedAt });
    const supplied = { ...row };
    delete supplied.sha;
    if (JSON.stringify(restored) !== JSON.stringify(supplied))
      throw fail('vault-standalone-restore-source-changed');
    return restored;
  });

  const refPath = '/git/ref/heads/' + encodeURIComponent(client.branch);
  const head = (await client.call(refPath))?.object?.sha;
  if (head !== expectedHead)
    throw fail('vault-standalone-restore-target-head-changed');

  const oldCommit = await client.call('/git/commits/' + head);
  const treeSha = oldCommit?.tree?.sha;
  if (!SHA.test(treeSha || ''))
    throw fail('vault-standalone-restore-target-tree-unavailable', 503);
  const tree = await client.call('/git/trees/' + treeSha + '?recursive=1');
  if (!Array.isArray(tree?.tree) || tree.truncated === true ||
      tree.tree.length > 30000)
    throw fail('vault-standalone-restore-target-tree-incomplete');

  const paths = new Set();
  let existingCount = 0;
  for (const item of tree.tree) {
    if (typeof item?.path !== 'string')
      throw fail('vault-standalone-restore-target-tree-invalid');
    if (item.path === kind) {
      if (item.type !== 'tree' ||
          (item.mode !== undefined && item.mode !== '040000'))
        throw fail('vault-standalone-restore-target-tree-invalid');
      continue;
    }
    if (!item.path.startsWith(kind + '/')) continue;
    const id = item.path.endsWith('.json') ? item.path.slice(kind.length + 1, -5) : '';
    if (!UUID.test(id) || item.path !== standaloneCapturePath(kind, id) ||
        item.type !== 'blob' ||
        (item.mode !== undefined && item.mode !== '100644') ||
        !SHA.test(item.sha || '') || paths.has(item.path))
      throw fail('vault-standalone-restore-target-tree-invalid');
    paths.add(item.path);
    existingCount++;
  }
  if (existingCount + records.length > KINDS[kind].max)
    throw fail('vault-standalone-restore-capacity-exceeded', 413);
  if (records.some((row) => paths.has(standaloneCapturePath(kind, row.id))))
    throw fail('vault-standalone-restore-existing-entry');
  const changes = records.map((row) => ({
    path: standaloneCapturePath(kind, row.id),
    mode: '100644', type: 'blob',
    content: JSON.stringify(row) + '\n',
  }));
  if (changes.reduce((sum, entry) => sum +
      Buffer.byteLength(entry.content, 'utf8'), 0) > maxBytes)
    throw fail('vault-standalone-restore-size-exceeded', 413);
  // A fresh target HEAD read immediately precedes FIRST GitHub mutation.
  if ((await client.call(refPath))?.object?.sha !== expectedHead)
    throw fail('vault-standalone-restore-target-head-changed');

  const nextTree = await client.call('/git/trees', {
    method: 'POST', body: { base_tree: treeSha, tree: changes },
  });
  if (!SHA.test(nextTree?.sha || ''))
    throw fail('vault-standalone-restore-new-tree-unconfirmed', 503);
  const commit = await client.call('/git/commits', {
    method: 'POST', body: {
      message: commitMessage, tree: nextTree.sha, parents: [expectedHead],
    },
  });
  if (!SHA.test(commit?.sha || ''))
    throw fail('vault-standalone-restore-new-commit-unconfirmed', 503);
  let patchError = null;
  try {
    await client.call(refPath, {
      method: 'PATCH', body: { sha: commit.sha, force: false },
    });
  } catch (e) { patchError = e; }

  // PATCH may succeed even if the response is lost. Read-only checking is
  // allowed; NEVER retry the GitHub PATCH or create another commit here.
  const after = await client.call(refPath).catch(() => {
    throw fail('vault-standalone-restore-github-unknown', 503);
  });
  if (after?.object?.sha !== commit.sha) {
    if (patchError instanceof VaultGitHubError &&
        [409, 422].includes(patchError.status))
      throw fail('vault-standalone-restore-target-conflict');
    throw fail('vault-standalone-restore-github-unknown', 503);
  }
  const verifiedCommit = await client.call('/git/commits/' + commit.sha)
    .catch(() => { throw fail('vault-standalone-restore-github-unknown', 503); });
  if (verifiedCommit?.tree?.sha !== nextTree.sha ||
      verifiedCommit?.message !== commitMessage ||
      !Array.isArray(verifiedCommit.parents) ||
      !verifiedCommit.parents.some((parent) =>
        (typeof parent === 'string' ? parent : parent?.sha) === expectedHead))
    throw fail('vault-standalone-restore-github-unknown', 503);
  const finalTree = await client.call('/git/trees/' + nextTree.sha + '?recursive=1')
    .catch(() => { throw fail('vault-standalone-restore-github-unknown', 503); });
  if (!Array.isArray(finalTree?.tree) || finalTree.truncated === true ||
      finalTree.tree.length > 30000)
    throw fail('vault-standalone-restore-github-unknown', 503);
  const treePaths = new Map();
  for (const entry of finalTree.tree) {
    if (entry?.type === 'blob' && typeof entry.path === 'string') {
      if (treePaths.has(entry.path))
        throw fail('vault-standalone-restore-github-unknown', 503);
      treePaths.set(entry.path, entry.sha);
    }
  }

  const results = [];
  for (const row of records) {
    const sha = treePaths.get(standaloneCapturePath(kind, row.id));
    if (!SHA.test(sha || ''))
      throw fail('vault-standalone-restore-github-unknown', 503);
    const written = await readVaultStandaloneBlob(client, kind, row.id, sha)
      .catch(() => { throw fail('vault-standalone-restore-github-unknown', 503); });
    const checked = { ...written };
    delete checked.sha;
    if (JSON.stringify(checked) !== JSON.stringify(row))
      throw fail('vault-standalone-restore-github-unknown', 503);
    results.push({ id: row.id, sha });
  }
  if ((await client.call(refPath))?.object?.sha !== commit.sha)
    throw fail('vault-standalone-restore-github-unknown', 503);
  return { commitSha: commit.sha, records: results };
}
