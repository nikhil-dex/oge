import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  captureEditorScope, encodeLocalRecovery, parseLocalRecovery,
  normalizeEditorContent, currentCaptureMatchesPending,
} from '../lib/oge-vault-standalone-editor.js';

const OWNER = 'disposable-auth-owner';
const UUID = randomUUID();
const SHA = 'a'.repeat(40);
const NEW_SHA = 'b'.repeat(40);

test('M72 sessionStorage recovery keys separate signed owners, repos, resource kinds and UUIDs', () => {
  const k = captureEditorScope(OWNER, 17, 'quick-notes', UUID);
  const variants = [
    k,
    captureEditorScope(OWNER, 17, 'airnotes', UUID),
    captureEditorScope(OWNER, 18, 'quick-notes', UUID),
    captureEditorScope('other-owner', 17, 'quick-notes', UUID),
    captureEditorScope(OWNER, 17, 'quick-notes', randomUUID()),
    captureEditorScope(OWNER, 17, 'quick-notes'),
  ];
  assert.equal(new Set(variants).size, variants.length);
  assert.ok(k.startsWith('oge-vault-standalone-session:v1:'));
  for (const invalid of [
    ['', 17, 'airnotes', UUID],
    [OWNER, 0, 'airnotes', UUID],
    [OWNER, 17, 'notes', UUID],
    [OWNER, 17, '../airnotes', UUID],
    [OWNER, 17, 'airnotes', '../../secrets'],
  ]) assert.throws(() => captureEditorScope(...invalid), TypeError);
});

test('M72 browser content normalizes line endings but denies oversized text/UTF8', () => {
  assert.equal(normalizeEditorContent('One\r\nTwo\rThree'), 'One\nTwo\nThree');
  assert.equal(normalizeEditorContent(''), '');
  assert.throws(() => normalizeEditorContent(123), TypeError);
  assert.throws(() => normalizeEditorContent('x'.repeat(20001)), TypeError);
  assert.throws(() => normalizeEditorContent('😀'.repeat(9000)), TypeError);
});

test('M72 typed local recovery is strictly canonical, bound to one ID/type/base GitHub SHA', () => {
  const capture = {
    kind: 'quick-notes', id: UUID,
    content: 'First line\nBody', baseSha: SHA,
  };
  const encoded = encodeLocalRecovery(capture);
  assert.deepEqual(parseLocalRecovery(encoded, 'quick-notes', UUID),
    { ...capture, version: 1 });
  assert.equal(parseLocalRecovery(encoded, 'airnotes', UUID), null);
  assert.equal(parseLocalRecovery(encoded, 'quick-notes', randomUUID()), null);
  assert.equal(parseLocalRecovery(encoded + ' ', 'quick-notes', UUID), null);
  assert.equal(parseLocalRecovery('{"abc":123}', 'quick-notes', UUID), null);
  assert.equal(parseLocalRecovery('not JSON', 'quick-notes', UUID), null);
  assert.equal(parseLocalRecovery('x'.repeat(50000), 'quick-notes', UUID), null);
  assert.doesNotMatch(
    encodeLocalRecovery({ ...capture, githubToken: 'must never persist' }),
    /githubToken|must never persist/,
    'the recovery encoder allowlists fields and never persists credentials');
});

test('M72 read-only GitHub proof requires exact format/content/new blob and valid revision', () => {
  const pending = {
    id: UUID, kind: 'quick-notes', baseSha: SHA,
    content: 'Draft text', revision: 3,
  };
  const saved = {
    id: UUID, kind: 'quick-notes', format: 'ogenotes-quick-note',
    content: 'Draft text', sha: NEW_SHA,
  };
  assert.equal(currentCaptureMatchesPending(pending, saved), true);
  for (const wrong of [
    { ...saved, content: 'Another user wrote' },
    { ...saved, kind: 'airnotes' },
    { ...saved, format: 'ogenotes-airnote' },
    { ...saved, sha: SHA },
    { ...saved, id: randomUUID() },
    { ...saved, sha: 'broken' },
  ]) assert.equal(currentCaptureMatchesPending(pending, wrong), false);
  assert.equal(currentCaptureMatchesPending({ ...pending, revision: 0 }, saved), false);
  assert.equal(currentCaptureMatchesPending({ ...pending, baseSha: 'not-sha' }, saved), false);
  assert.equal(currentCaptureMatchesPending({ ...pending, baseSha: null }, saved), true);
});

test('M72 route requires independent editor/staging gates, signed owner/version and Vault mapping', async () => {
  const src = await readFile(new URL(
    '../app/vault/standalone-editor/page.js', import.meta.url), 'utf8');
  for (const guard of [
    /OGE_VAULT_STANDALONE_EDITOR_PREVIEW === 'true'/,
    /OGE_VAULT_STANDALONE_PREVIEW === 'true'/,
    /OGE_VAULT_STANDALONE_DRAFT_PREVIEW === 'true'/,
    /checkVaultStagingReadiness\(env\)\.ok/,
    /oge_vault_restore_staging_/,
    /env\.OGE_STAGING_URL === env\.AUTH_URL/,
    /if \(!previewEnabled\(\)\) notFound\(\)/,
    /const session = await auth\(\)/,
    /sessionVersion: session\.user\.sessionVersion/,
    /account\?\.vault\?\.status !== 'connected'/,
    /ownerMutationFilter\(session\.user\.id/,
  ]) assert.match(src, guard);
  assert.doesNotMatch(src,
    /collection\(['"](?:quickNotes|personalQuickNotes|notes)['"]\)|commitVaultStandaloneCapture|insertOne\(/);
});

test('M72 client uses AES-GCM draft API, explicit GitHub POST/PUT and read-only uncertainty check only', async () => {
  const src = await readFile(new URL(
    '../app/vault/standalone-editor/standalone-vault-editor.js', import.meta.url),
    'utf8');
  for (const guard of [
    /captureEditorScope\(ownerId, repoId, editor\.kind, editor\.id\)/,
    /sessionStorage\.setItem/,
    /sessionStorage\.removeItem/,
    /readLocal\(kind, entry\.id\)/,
    /Browser and encrypted drafts differ/,
    /method: 'PUT', cache: 'no-store'/,
    /savedTo !== 'temporary-encrypted-draft'/,
    /committedToGitHub !== false/,
    /revisionRef\.current \+ 1/,
    /const timer = window\.setTimeout/,
    /method: current\.baseSha \? 'PUT' : 'POST'/,
    /const rev = await persist\(/,
    /pendingGitHubRef\.current = pending/,
    /setUncertain\(true\)/,
    /currentCaptureMatchesPending\(pending, saved\)/,
    /currentCaptureMatchesPending\(pending, current\)/,
    /method: 'POST', cache: 'no-store'/,
    /confirmation\?\.confirmed/,
    /confirmation\?\.cleared/,
    /No GitHub retry/,
    /read-only; no retry/,
  ]) assert.match(src, guard);
  assert.doesNotMatch(src,
    /\/api\/quick-notes|\/api\/personal-quick-notes|\/api\/extension\/quick-note|Bearer |localStorage\.|collection\(/);
  assert.equal((src.match(/fetch\(API, \{/g) || []).length, 1,
    'one explicit GitHub save mutation callsite only');
});

test('M72 preserved normal legacy standalone pages and recovery API semantics', async () => {
  const legacyQuick = await readFile(new URL(
    '../app/quick-notes/page.js', import.meta.url), 'utf8');
  const legacyAir = await readFile(new URL(
    '../app/components/personal-quick-notes-panel.js', import.meta.url), 'utf8');
  const drafts = await readFile(new URL(
    '../app/api/vault/standalone-drafts/route.js', import.meta.url), 'utf8');
  assert.match(legacyQuick, /\/api\/quick-notes/);
  assert.match(legacyAir, /\/api\/personal-quick-notes/);
  assert.match(drafts, /readOnly: true/);
  assert.match(drafts, /reconcileStandaloneDraft/);
  assert.doesNotMatch(drafts, /commitVaultStandaloneCapture/);
});
