import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  legacyNotesWorkspaceDestination, vaultLegacyCutoverDecision,
} from '../lib/oge-vault-cutover-guard.js';

const preview = {
  OGE_VAULT_CUTOVER_GUARD_PREVIEW: 'true',
  OGE_VAULT_MAIN_PREVIEW: 'true',
  OGE_VAULT_HYBRID_DRAFT_PREVIEW: 'true',
};

test('D2 unenabled routing never changes production /notes destination', () => {
  const connected = { vault: { status: 'connected', repoId: 23, installationId: 45 } };
  const decision = vaultLegacyCutoverDecision(connected, { env: {} });
  assert.equal(legacyNotesWorkspaceDestination(decision), 'legacy');
});

test('D2 only fully connected GitHub Vault owners enter the existing GitHub-only Notes UI', () => {
  const valid = vaultLegacyCutoverDecision({
    vault: { status: 'connected', repoId: 23, installationId: 45 },
  }, { env: preview });
  assert.equal(valid.code, 'vault-cutover-legacy-disabled');
  assert.equal(legacyNotesWorkspaceDestination(valid), 'vault');

  for (const vault of [
    { status: 'connected', repoId: null, installationId: 1 },
    { status: 'connected', repoId: 1, installationId: 0 },
    { status: 'provisioning', repoId: 1, installationId: 1 },
    { status: 'revoked', repoId: 1, installationId: 1 },
  ]) {
    const decision = vaultLegacyCutoverDecision({ vault }, { env: preview });
    assert.equal(legacyNotesWorkspaceDestination(decision), 'blocked');
  }
});

test('D2 owner/session loss and staging misconfiguration cannot silently render legacy Notes', () => {
  const noOwner = vaultLegacyCutoverDecision(null, { env: preview });
  assert.equal(legacyNotesWorkspaceDestination(noOwner), 'blocked');
  for (const missing of ['OGE_VAULT_MAIN_PREVIEW', 'OGE_VAULT_HYBRID_DRAFT_PREVIEW']) {
    const decision = vaultLegacyCutoverDecision({ vault: {
      status: 'connected', repoId: 1, installationId: 2,
    } }, { env: { ...preview, [missing]: 'false' } });
    assert.equal(legacyNotesWorkspaceDestination(decision), 'blocked');
  }
  assert.equal(legacyNotesWorkspaceDestination(null), 'blocked');
  assert.equal(legacyNotesWorkspaceDestination({ blocked: false, mode: 'unknown' }), 'blocked');
});

test('D2 signed server layout redirects only after authenticated, owner-scoped decision', async () => {
  const layout = await readFile(new URL('../app/notes/layout.js', import.meta.url), 'utf8');
  const vault = await readFile(new URL('../app/vault/notes/page.js', import.meta.url), 'utf8');
  const classic = await readFile(new URL('../app/notes/page.js', import.meta.url), 'utf8');
  assert.match(layout, /inspectLegacyCutoverForOwner/);
  assert.match(layout, /const session = await auth\(\)/);
  assert.match(layout, /if \(!session\?\.user\?\.id\) redirect\('\/register'\)/);
  assert.match(layout, /inspectLegacyCutoverForOwner\(/);
  assert.match(layout, /sessionVersion: session\.user\.sessionVersion/);
  assert.match(layout, /legacyNotesWorkspaceDestination\(decision\)/);
  assert.match(layout, /if \(destination === 'vault'\) redirect\('\/vault\/notes'\)/);
  assert.match(layout, /if \(destination === 'legacy'\) return children/);
  assert.doesNotMatch(layout, /notesApi="\/api\/notes"|collection\('notes'\)|commitVaultNoteBatch\(/);
  assert.match(vault, /<NotesPage notesApi="\/api\/vault\/notes-main" vaultMode/);
  assert.match(classic, /notesApi = '\/api\/notes', vaultMode = false/);
});

test('D2 bad connection never renders an unguarded legacy client from the blocked branch', async () => {
  const layout = await readFile(new URL('../app/notes/layout.js', import.meta.url), 'utf8');
  const blocked = layout.slice(layout.indexOf('if (destination === \'legacy\') return children;'));
  assert.match(blocked, /role="alert"/);
  assert.match(blocked, /decision\.error/);
  assert.doesNotMatch(blocked, /\{children\}|redirect\('\/notes'\)/);
});
