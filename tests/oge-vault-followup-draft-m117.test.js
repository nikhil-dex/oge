import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stageVaultFollowupSave, retireSubmittedVaultDraft } from '../lib/oge-vault-followup-save.js';

const id = 'f0000000-0000-4000-8000-000000000001';
const subjectSlug = 'abcdefff-1234-4123-8123-123456789abc';
const sha = 'a'.repeat(40);

function committed() {
  return {
    id, subjectSlug, sha,
    heading: 'Computer Networks', answer: 'Chapter one',
    tags: ['cn'], favorite: false,
  };
}

test('M117 verified cleanup removes only the submitted temporary draft, never newer browser edits', async () => {
  const browser = { heading: 'Computer Networks', answer: 'Chapter one and two',
    tagsText: 'cn, arq' };
  const followup = stageVaultFollowupSave([], committed(), browser);
  const localCopy = JSON.stringify({ draft: followup.pendingDraft });
  const database = new Map([[id, {
    revision: 3, sha, body: 'Chapter one',
  }]]);
  const calls = [];
  const cleanup = await retireSubmittedVaultDraft({
    id, revision: 3, sha,
    reconcile: async (payload) => {
      calls.push(payload);
      const stored = database.get(payload.id);
      if (!stored || stored.revision !== payload.revision ||
          stored.sha !== payload.sha) return { confirmed: false, cleared: false };
      database.delete(payload.id);
      return { confirmed: true, cleared: true };
    },
  });
  assert.deepEqual(calls, [{ id, revision: 3, sha }]);
  assert.equal(cleanup.cleared, true);
  assert.equal(cleanup.skipped, false);
  assert.equal(database.size, 0, 'only the prior submitted server draft was cleared');
  assert.equal(JSON.parse(localCopy).draft.answer, 'Chapter one and two');
  assert.equal(JSON.parse(localCopy).draft.baseSha, sha);
  assert.equal(followup.editingId, id);
  assert.equal(followup.newDraftId, '');
});

test('M117 rejected cleanup keeps the pending revision for an ordinary next autosave', async () => {
  let calls = 0;
  const cleanup = await retireSubmittedVaultDraft({
    id, revision: 7, sha,
    reconcile: async () => { calls++; return {
      confirmed: false, cleared: false, reason: 'newer-draft-present',
    }; },
  });
  assert.equal(calls, 1);
  assert.equal(cleanup.cleared, false);
  assert.equal(cleanup.skipped, false);
});

test('M117 network failure does not report cleanup success or discard a draft', async () => {
  const browserDraft = stageVaultFollowupSave([], committed(), {
    heading: 'Computer Networks', answer: 'Newer browser-only text', tagsText: '',
  }).pendingDraft;
  const cleanup = await retireSubmittedVaultDraft({
    id, revision: 2, sha,
    reconcile: async () => { throw new Error('Disconnected'); },
  });
  assert.equal(cleanup.cleared, false);
  assert.equal(cleanup.skipped, false);
  assert.equal(browserDraft.answer, 'Newer browser-only text');
});

test('M117 a new Note with no MongoDB draft skips cleanup without a request', async () => {
  let calls = 0;
  const result = await retireSubmittedVaultDraft({
    id, revision: 0, sha,
    reconcile: async () => { calls++; return { confirmed: false, cleared: false }; },
  });
  assert.equal(result.cleared, true);
  assert.equal(result.skipped, true);
  assert.equal(calls, 0);
});

test('M117 refuse invalid IDs, SHAs, revisions and missing verified reconciler', async () => {
  for (const params of [
    { id: 'invalid', revision: 1, sha },
    { id, revision: -1, sha }, { id, revision: 2.1, sha },
    { id, revision: 1, sha: 'bad' },
  ]) await assert.rejects(retireSubmittedVaultDraft({
    ...params, reconcile: async () => ({ confirmed: true, cleared: true }),
  }), TypeError);
  await assert.rejects(retireSubmittedVaultDraft({
    id, revision: 1, sha,
  }), TypeError);
});

test('M117 real Notes editor calls GitHub-confirmed reconciliation before resetting draft revision', async () => {
  const ui = await readFile(new URL('../app/notes/page.js', import.meta.url), 'utf8');
  const api = await readFile(new URL('../app/api/vault/drafts/route.js', import.meta.url), 'utf8');
  const block = ui.slice(ui.indexOf('const submittedRevision = hybridRevisionRef.current;'),
    ui.indexOf('// The editor\'s visible heading/body/tags are deliberately untouched.', ui.indexOf('const submittedRevision = hybridRevisionRef.current;')));
  assert.match(block, /await retireSubmittedVaultDraft\(/);
  assert.match(block, /reconcile: async \(body\) => responseJson\(await fetch\('\/api\/vault\/drafts'/);
  assert.match(block, /method: 'POST'/);
  assert.match(block, /if \(cleanup\.cleared\)/);
  assert.match(block, /hybridRevisionRef\.current = 0/);
  assert.match(block, /newDraftPointerKey\(activeSubject\)/);
  assert.match(block, /window\.sessionStorage\.removeItem/);
  assert.match(ui, /JSON\.stringify\(\{ draft: followup\.pendingDraft \}\)/);
  assert.match(ui, /draft cleanup could not be confirmed/);
  // The POST endpoint is the authenticated CAS reconciler, not a blind
  // delete based on a client-provided sha.
  assert.match(api, /reconcileConfirmedVaultDraft\(/);
  assert.match(api, /withVaultSubjectWrite\(/);
  assert.match(api, /const current = await getHybridDraft\(/);
});
