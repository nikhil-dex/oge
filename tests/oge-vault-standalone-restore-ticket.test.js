import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { validatedStandaloneCapture } from '../lib/oge-vault-standalone-captures.js';
import { exportVaultCurrentResourcesSnapshot } from '../lib/oge-vault-backup-current-resources.js';
import { VaultGitHubError } from '../lib/oge-vault-github.js';
import {
  standaloneRestoreTicketIdentity, standaloneRestoreApprovalBinding,
  issueStandaloneRestoreTicket, verifyStandaloneRestoreTicket,
} from '../lib/oge-vault-standalone-restore-ticket.js';

const H = (v) => createHash('sha1').update(v).digest('hex');
const KEY = '8c'.repeat(32);
const NOW = Date.parse('2026-11-17T00:00:00.000Z');
const TARGET = H('m76-disposable-target');
const VAULT = {
  repoId: 1551, installationId: 317,
  repoName: 'ogenotes-vault', githubAccountId: '991',
  githubLogin: 'm76-test-user',
};
const identity = () => ({
  ownerId: 'm76-owner-' + randomUUID(), sessionVersion: randomUUID(),
});

async function syntheticApproval() {
  const id = randomUUID();
  const note = validatedStandaloneCapture('quick-notes', {
    content: 'PRIVATE TEST RESTORE BODY',
  }, { id, now: '2026-11-17T00:00:00.000Z' });
  const sha = H('m76-source-blob');
  const sourceHead = H('m76-source-head');
  const sourceTree = H('m76-source-tree');
  const client = {
    readOnly: true, branch: 'main', vault: VAULT,
    async call(path) {
      if (path === '/git/ref/heads/main')
        return { object: { sha: sourceHead } };
      if (path === '/git/commits/' + sourceHead)
        return { tree: { sha: sourceTree } };
      if (path === '/git/trees/' + sourceTree + '?recursive=1')
        return { truncated: false, tree: [{
          path: 'quick-notes/' + id + '.json',
          type: 'blob', mode: '100644', sha,
          size: Buffer.byteLength(JSON.stringify(note)),
        }] };
      throw Error('Unexpected source fixture path ' + path);
    },
  };
  const archive = await exportVaultCurrentResourcesSnapshot(client, {
    subjectVerifier: async (subjects) => subjects.length === 0,
    noteReader: async () => { throw Error('No linked Notes'); },
    standaloneReader: async (_client, kind, checkId, checkSha) => {
      assert.equal(kind, 'quick-notes');
      assert.equal(checkId, id);
      assert.equal(checkSha, sha);
      return { ...note, sha };
    },
  });
  const approval = {
    archive, kind: 'quick-notes',
    selectedIds: [id], expectedTargetHead: TARGET,
    expectedSelectionFingerprint: 'f'.repeat(64),
    confirmation: 'COMMIT_SELECTED_STANDALONE_CREATE_ONLY',
  };
  return { archive, approval };
}

test('M76 issue+verify one-time HMAC receipt is signed to exact owner/repo/session and reviewed standalone selection', async () => {
  const { approval } = await syntheticApproval();
  const owner = standaloneRestoreTicketIdentity(identity(), { vault: VAULT });
  const binding = standaloneRestoreApprovalBinding(approval);
  const issued = issueStandaloneRestoreTicket(owner, binding, {
    secret: KEY, now: NOW, nonce: randomUUID(),
  });
  assert.match(issued.ticket, /^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/);
  assert.equal(issued.ticket.length < 4096, true);
  assert.equal(issued.expiresAt.getTime(), NOW + 600000);
  const verified = verifyStandaloneRestoreTicket(
    issued.ticket, owner, binding, { secret: KEY, now: NOW + 1 },
  );
  assert.equal(verified.nonceHash, issued.nonceHash);
  assert.equal(verified.approvalHash, issued.approvalHash);
  assert.equal(verified.kind, 'quick-notes');
  assert.equal(verified.selectedCount, 1);
  assert.equal(JSON.stringify(verified).includes('PRIVATE TEST'), false);
  assert.equal(issued.ticket.includes('PRIVATE TEST'), false);
  assert.equal(JSON.stringify(binding).includes('PRIVATE TEST'), false);
});

test('M76 cross-user, stale-session, repo/install/account/login changes and wrong approval never verify', async () => {
  const { approval } = await syntheticApproval();
  const owner = standaloneRestoreTicketIdentity(identity(), { vault: VAULT });
  const binding = standaloneRestoreApprovalBinding(approval);
  const issued = issueStandaloneRestoreTicket(owner, binding, {
    secret: KEY, now: NOW,
  });
  const badOwners = [
    { ...owner, ownerId: 'different-signed-owner' },
    { ...owner, sessionVersion: randomUUID() },
    { ...owner, repoId: owner.repoId + 1 },
    { ...owner, installationId: owner.installationId + 1 },
    { ...owner, githubAccountId: '992' },
    { ...owner, githubLogin: 'someone-else' },
    { ...owner, repoName: 'different-repository' },
  ];
  for (const bad of badOwners)
    assert.throws(() => verifyStandaloneRestoreTicket(
      issued.ticket, bad, binding, { secret: KEY, now: NOW + 1000 }));
  const badBinding = [
    { ...binding, kind: 'airnotes' },
    { ...binding, selectedIds: [randomUUID()] },
    { ...binding, expectedTargetHead: H('other-target') },
    { ...binding, expectedSelectionFingerprint: 'a'.repeat(64) },
    { ...binding, sourceSnapshot: H('wrong-source') },
    { ...binding, sourceArchiveSha256: 'b'.repeat(64) },
  ];
  for (const changed of badBinding)
    assert.throws(() => verifyStandaloneRestoreTicket(
      issued.ticket, owner, changed, { secret: KEY, now: NOW + 1000 }));
});

test('M76 rejects expired/future, altered HMAC, malformed payload, wrong secret, or noncanonical ticket', async () => {
  const { approval } = await syntheticApproval();
  const owner = standaloneRestoreTicketIdentity(identity(), { vault: VAULT });
  const binding = standaloneRestoreApprovalBinding(approval);
  const issued = issueStandaloneRestoreTicket(owner, binding, {
    secret: KEY, now: NOW,
  });
  const [packed, mac] = issued.ticket.split('.');
  const changed = Buffer.from(JSON.stringify({
    ...JSON.parse(Buffer.from(packed, 'base64url').toString()),
    repoId: 999,
  })).toString('base64url');
  const invalid = [
    packed + '.' + '0'.repeat(64),
    changed + '.' + mac,
    issued.ticket + 'extra',
    'malformed-ticket',
    issued.ticket.slice(0, -1) + (mac.at(-1) === 'a' ? 'b' : 'a'),
  ];
  for (const raw of invalid)
    assert.throws(() => verifyStandaloneRestoreTicket(
      raw, owner, binding, { secret: KEY, now: NOW + 300 }));
  for (const now of [NOW + 600000, NOW - 30000])
    assert.throws(() => verifyStandaloneRestoreTicket(
      issued.ticket, owner, binding, { secret: KEY, now }));
  assert.throws(() => issueStandaloneRestoreTicket(
    owner, binding, { secret: 'invalid', now: NOW }));
  assert.throws(() => verifyStandaloneRestoreTicket(
    issued.ticket, owner, binding, { secret: 'invalid', now: NOW + 1000 }));
});

test('M76 cannot issue a ticket for Notes, a mismatched kind, duplicate selection, or a changed archive', async () => {
  const { approval } = await syntheticApproval();
  const invalid = [
    { ...approval, kind: 'notes' },
    { ...approval, kind: 'airnotes' },
    { ...approval, selectedIds: [approval.selectedIds[0], approval.selectedIds[0]] },
    { ...approval, selectedIds: [randomUUID()] },
    { ...approval, archive: { ...approval.archive,
      archiveSha256: 'a'.repeat(64) } },
    { ...approval, confirmation: 'PREPARE_SELECTED_STANDALONE_CREATE_ONLY' },
  ];
  for (const value of invalid)
    assert.throws(() => standaloneRestoreApprovalBinding(value),
      e => e instanceof VaultGitHubError);
});

test('M76 authorize route only issues read-only one-time tickets, while commit cannot bypass claim', async () => {
  const shared = await readFile(new URL(
    '../lib/oge-vault-standalone-restore-staging.js',
    import.meta.url), 'utf8');
  const route = await readFile(new URL(
    '../app/api/vault/backup-current-resources/authorize/route.js',
    import.meta.url), 'utf8');
  const commit = await readFile(new URL(
    '../app/api/vault/backup-current-resources/commit/route.js',
    import.meta.url), 'utf8');
  const core = await readFile(new URL(
    '../lib/oge-vault-standalone-restore-ticket.js',
    import.meta.url), 'utf8');
  assert.match(shared, /OGE_VAULT_STANDALONE_RESTORE_APPROVAL_PREVIEW !== 'true'/);
  assert.match(shared, /\(write \|\| authorize\)/);
  assert.match(route, /standaloneRestoreStagingAllowed\(request, \{ authorize: true \}\)/);
  assert.match(route, /AUTHORIZE_SELECTED_STANDALONE_CREATE_ONLY/);
  assert.match(route, /prepareVaultStandaloneRestoreIntent/);
  assert.match(route, /issueStandaloneRestoreTicket/);
  assert.match(route, /recordStandaloneRestoreTicket/);
  assert.match(route, /immediatelyExecutesRestore: false/);
  assert.doesNotMatch(route, /getVaultNoteClient|withVaultOwnerImportExclusive|commitCreateOnlyStandaloneRestores/);
  assert.match(commit, /verifyStandaloneRestoreTicket/);
  assert.match(commit, /withVaultOwnerImportExclusive/);
  assert.match(commit, /claimStandaloneRestoreTicketOnce/);
  assert.match(commit, /confirmStandaloneRestoreTicket/);
  assert.match(commit, /executeApprovedStandaloneRestoreBatch/);
  const lock = commit.indexOf('withVaultOwnerImportExclusive');
  const claim = commit.indexOf('await claimStandaloneRestoreTicketOnce');
  const writer = commit.indexOf('const writeClient = await getVaultNoteClient');
  const execute = commit.indexOf('await executeApprovedStandaloneRestoreBatch');
  const confirm = commit.indexOf('await confirmStandaloneRestoreTicket');
  assert.ok(lock >= 0 && lock < claim && claim < writer &&
    writer < execute && execute < confirm);
  assert.match(core, /createHmac\('sha256'/);
  assert.match(core, /timingSafeEqual/);
  assert.match(core, /expiresAt: \{ \$gt: now \}/);
  assert.match(core, /state: 'pending'/);
  assert.match(core, /state: 'claimed'/);
  assert.match(core, /state: 'confirmed'/);
  assert.match(core, /vault_standalone_restore_approvals/);
  assert.doesNotMatch(core + route, /collection\('notes'\)|insertOne\(\{.*content:|commitVaultNoteBatch/);
  assert.doesNotMatch(commit, /export async function GET|export async function PUT|export async function DELETE/);
});
