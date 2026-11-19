import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { vaultSaveFailureMessage } from '../lib/oge-vault-save-feedback.js';

test('M121 actionable GitHub Save errors distinguish missing access from an uncertain commit', () => {
  assert.match(vaultSaveFailureMessage('vault-repository-token-scope-failed'), /repository access/);
  assert.match(vaultSaveFailureMessage({ message: 'github-permission-denied' }), /Contents: Read and write/);
  assert.match(vaultSaveFailureMessage('github-rate-limited'), /temporarily limited/);
  assert.match(vaultSaveFailureMessage('vault-note-conflict'), /reload/);
  assert.match(vaultSaveFailureMessage('vault-commit-unconfirmed'), /may have received/);
  assert.match(vaultSaveFailureMessage('vault-subject-locked-or-missing'), /subject/);
  assert.match(vaultSaveFailureMessage('some-unknown-status'), /some-unknown-status/);
  assert.doesNotMatch(vaultSaveFailureMessage({ message: 'secret=private-key' }), /private-key/);
});

test('M121 failed Save shows actionable feedback in the existing Notes modal and leaves draft', async () => {
  const page = await readFile(new URL('../app/notes/page.js', import.meta.url), 'utf8');
  assert.match(page, /vaultSaveFailureMessage\(err\)/);
  assert.match(page, /GitHub Save not confirmed — keep your draft/);
  assert.match(page, /Check your Vault connection/);
  assert.match(page, /if \(attemptedGitHubSave && hybridDrafts && vaultMode\)/);
  assert.match(page, /setNoteDialog\(false\)/);
  const api = await readFile(new URL('../app/api/vault/notes-main/route.js', import.meta.url), 'utf8');
  assert.match(api, /commitVaultNoteBatch\(ctx\.client/);
  assert.doesNotMatch(api, /collection\(['"]notes['"]\)/);
});
