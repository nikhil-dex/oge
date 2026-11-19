import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { vaultCaptureAvailable, standaloneNotesDestination } from '../lib/oge-vault-workspace-routing.js';
import { vaultLegacyCutoverDecision, legacyNotesWorkspaceDestination } from '../lib/oge-vault-cutover-guard.js';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const env = { OGE_VAULT_MAIN_PREVIEW: 'true', OGE_VAULT_HYBRID_DRAFT_PREVIEW: 'true' };
const connected = { status: 'connected', repoId: 10, installationId: 20 };

test('M118 explicit MongoDB choice keeps familiar Notes even if a Vault is connected', () => {
  const account = { notesStorage: 'mongodb', vault: connected };
  assert.deepEqual(vaultLegacyCutoverDecision(account, {
    env: { ...env, OGE_VAULT_CUTOVER_GUARD_PREVIEW: 'true' },
  }), { blocked: false, mode: 'legacy' });
  assert.equal(vaultCaptureAvailable(account, env), false);
  assert.equal(standaloneNotesDestination(account, env), null);
});

test('M118 GitHub choice has no legacy content fallback before or after setup', () => {
  const pending = { notesStorage: 'github' };
  assert.equal(standaloneNotesDestination(pending, env), '/vault?setup=onboarding');
  const required = vaultLegacyCutoverDecision(pending, { env });
  assert.equal(required.code, 'vault-storage-setup-required');
  assert.equal(required.status, 409);
  assert.equal(legacyNotesWorkspaceDestination(required), 'blocked');

  const disabled = vaultLegacyCutoverDecision(pending, { env: {} });
  assert.equal(disabled.code, 'vault-storage-not-ready');
  assert.equal(disabled.status, 503);

  const ready = { ...pending, vault: connected };
  assert.equal(standaloneNotesDestination(ready, env), '/vault/capture');
  assert.equal(vaultLegacyCutoverDecision(ready, { env }).code, 'vault-cutover-legacy-disabled');
  assert.equal(legacyNotesWorkspaceDestination(vaultLegacyCutoverDecision(ready, { env })), 'vault');
});

test('M118 onboarding offers both stores beside news, even when news is skipped', async () => {
  const page = await read('../app/onboarding/page.js');
  const action = await read('../app/onboarding/actions.js');
  assert.match(page, /name="notesStorage" value="mongodb" required/);
  assert.match(page, /name="notesStorage" value="github" required/);
  assert.match(page, /private GitHub repository/);
  assert.match(page, /temporary draft autosave/);
  assert.match(page, /Skip news topics/);
  assert.doesNotMatch(page, /formNoValidate/);
  assert.match(action, /\['mongodb', 'github'\]\.includes\(storageChoice\)/);
  assert.match(action, /fromSettings \? \{\} : \{ notesStorage: storageChoice, onboardingComplete: true \}/);
  assert.match(action, /redirect\('\/vault\?setup=onboarding'\)/);
  assert.match(action, /ownerMutationFilter\(ownerId, \{ sessionVersion: session\.user\.sessionVersion \}\)/);
});

test('M118 signed Notes, Quick Notes, AirNotes and API routes honor storage choice', async () => {
  const layout = await read('../app/notes/layout.js');
  const home = await read('../app/page.js');
  const quick = await read('../app/quick-notes/layout.js');
  const air = await read('../app/airnotes/layout.js');
  const guard = await read('../lib/oge-vault-cutover-guard.js');
  assert.match(layout, /vault-storage-setup-required/);
  assert.match(layout, /redirect\('\/vault\?setup=onboarding'\)/);
  assert.match(home, /account\.notesStorage === 'github'/);
  assert.match(home, /account\.notesStorage === 'mongodb'/);
  for (const route of [quick, air]) {
    assert.match(route, /notesStorage: 1/);
    assert.match(route, /if \(destination\) redirect\(destination\)/);
  }
  assert.match(guard, /projection: \{ _id: 1, vault: 1, notesStorage: 1 \}/);
  for (const name of ['notes', 'quick-notes', 'personal-quick-notes']) {
    const src = await read('../app/api/' + name + '/route.js');
    assert.match(src, /inspectLegacyCutoverForOwner/);
  }
  const settings = await read('../app/settings/page.js');
  assert.match(settings, /name="returnTo" value="\/settings"/);
});

test('M118 fresh signups must pick storage before writing any Notes', async () => {
  const choiceRequired = { notesStorage: 'unselected' };
  assert.equal(vaultLegacyCutoverDecision(choiceRequired, { env: {} }).code,
    'notes-storage-choice-required');
  assert.equal(standaloneNotesDestination(choiceRequired, env), '/onboarding');
  assert.equal(legacyNotesWorkspaceDestination(
    vaultLegacyCutoverDecision(choiceRequired, { env: {} })), 'blocked');
  const auth = await read('../auth.js');
  const layout = await read('../app/notes/layout.js');
  assert.match(auth, /notesStorage: 'unselected'/);
  assert.match(layout, /decision.code === 'notes-storage-choice-required'/);
  assert.match(layout, /redirect\('\/onboarding'\)/);
});

test('M118 existing accounts with no explicit preference preserve legacy behavior', () => {
  assert.equal(vaultLegacyCutoverDecision({}, { env: {} }).blocked, false);
  assert.equal(standaloneNotesDestination({}, env), null);
  const oldConnected = { vault: connected };
  assert.equal(vaultLegacyCutoverDecision(oldConnected, { env: {} }).blocked, false);
  assert.equal(standaloneNotesDestination(oldConnected, env), '/vault/capture');
});
