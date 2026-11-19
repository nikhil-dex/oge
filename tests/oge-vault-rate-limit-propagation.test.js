import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('B7 preview routes preserve GitHub 429 without implying a GitHub Save succeeded', async () => {
  const notes = await readFile(new URL('../app/api/vault/notes-main/route.js', import.meta.url), 'utf8');
  const drafts = await readFile(new URL('../app/api/vault/drafts/route.js', import.meta.url), 'utf8');
  for (const source of [notes, drafts]) {
    assert.match(source, /error\.status === 429 \? 429/);
    assert.match(source, /'no-store'/);
    assert.doesNotMatch(source, /return json\(\{\s*saved:\s*true\s*\}/);
  }
  assert.match(notes, /OGE_VAULT_MAIN_PREVIEW !== 'true'/);
  assert.match(drafts, /OGE_VAULT_HYBRID_DRAFT_PREVIEW !== 'true'/);
  assert.match(drafts, /readConfirmedVaultSaveReceipt/);
  assert.match(drafts, /reconcileConfirmedVaultDraft/);
});

test('B7 CI browser smoke is anonymous; never claim its checks prove signed Vault E2E', async () => {
  const config = await readFile(new URL('../playwright.config.mjs', import.meta.url), 'utf8');
  const ci = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(config, /Local-only anonymous smoke tests/);
  assert.match(ci, /Run local-only anonymous browser tests/);
  assert.doesNotMatch(ci, /OGE_VAULT_GITHUB_PRIVATE_KEY_BASE64/);
});
