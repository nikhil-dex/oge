import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  vaultLegacyCutoverDecision, inspectLegacyCutoverForOwner,
  legacyCutoverBlockedResponse, vaultLegacyCutoverPreviewEnabled,
} from '../lib/oge-vault-cutover-guard.js';

const ownerId = 'phase-d-preview-owner';
const sessionVersion = randomUUID();
const preview = Object.freeze({
  OGE_VAULT_CUTOVER_GUARD_PREVIEW: 'true',
  OGE_VAULT_MAIN_PREVIEW: 'true',
  OGE_VAULT_HYBRID_DRAFT_PREVIEW: 'true',
});
const connected = { vault: {
  status: 'connected', repoId: 1001, installationId: 23,
} };

test('Phase D guard is default-off even for a connected Vault account', async () => {
  const env = {};
  assert.equal(vaultLegacyCutoverPreviewEnabled(env), false);
  assert.deepEqual(vaultLegacyCutoverDecision(connected, { env }),
    { blocked: false, mode: 'legacy' });
  const db = { collection() { throw Error('Disabled guard must not touch MongoDB'); } };
  assert.deepEqual(await inspectLegacyCutoverForOwner(db, ownerId,
    { sessionVersion }, { env }), { blocked: false, mode: 'legacy' });
});

test('Phase D connected Vault owners never fall back to permanent MongoDB storage in preview', async () => {
  const decision = vaultLegacyCutoverDecision(connected, { env: preview });
  assert.equal(decision.blocked, true);
  assert.equal(decision.status, 409);
  assert.equal(decision.code, 'vault-cutover-legacy-disabled');
  const response = legacyCutoverBlockedResponse(decision);
  assert.equal(response.status, 409);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const payload = await response.json();
  assert.equal(payload.code, decision.code);
  assert.equal(JSON.stringify(payload).includes(ownerId), false);
});

test('Phase D incomplete GitHub preview flags block requests before owner lookup', async () => {
  for (const field of ['OGE_VAULT_MAIN_PREVIEW', 'OGE_VAULT_HYBRID_DRAFT_PREVIEW']) {
    const env = { ...preview, [field]: 'false' };
    const decision = vaultLegacyCutoverDecision(connected, { env });
    assert.equal(decision.status, 503);
    assert.equal(decision.code, 'vault-cutover-preview-incomplete');
  }
});

test('Phase D account disappearance, partial provisioning and unknown Vault status fail closed', () => {
  assert.equal(vaultLegacyCutoverDecision(null, { env: preview }).status, 401);
  for (const vault of [
    { status: 'connected', repoId: 12 },
    { status: 'connected', installationId: 12 },
    { status: 'connected', repoId: '12', installationId: 5 },
    { status: 'provisioning' },
    { status: 'pending' },
    { status: 'unknown' },
    { status: 'disconnected', repoId: 1 },
  ]) {
    const decision = vaultLegacyCutoverDecision({ vault }, { env: preview });
    assert.equal(decision.status, 503);
    assert.equal(decision.blocked, true);
  }
  assert.equal(vaultLegacyCutoverDecision({}, { env: preview }).blocked, false);
  assert.equal(vaultLegacyCutoverDecision({
    vault: { status: 'disconnected' },
  }, { env: preview }).blocked, false);
});

test('Phase D signed owner check reads only account metadata and enforces session incarnation', async () => {
  const calls = [];
  const db = { collection(name) {
    assert.equal(name, 'users');
    return { async findOne(filter, options) {
      calls.push({ filter, options });
      return connected;
    } };
  } };
  const decision = await inspectLegacyCutoverForOwner(
    db, ownerId, { sessionVersion }, { env: preview });
  assert.equal(decision.blocked, true);
  assert.deepEqual(calls[0].filter, { googleSub: ownerId, sessionVersion });
  assert.deepEqual(calls[0].options.projection, { _id: 1, vault: 1 });
});

test('Phase D browser-extension checks require the verified token hash and preserve transactions', async () => {
  const tokenHash = 'a'.repeat(64);
  const session = {};
  let actual;
  const db = { collection() { return { async findOne(filter, options) {
    actual = { filter, options };
    return connected;
  } }; } };
  const result = await inspectLegacyCutoverForOwner(db, ownerId,
    { extensionTokenHash: tokenHash }, { env: preview, session });
  assert.equal(result.status, 409);
  assert.equal(actual.filter.extensionTokenHash, tokenHash);
  assert.ok(actual.filter.extensionTokenExpiresAt);
  assert.equal(actual.options.session, session);
});

test('Phase D preview protects backup imports and token-based extension capture without rewiring production', async () => {
  const helper = await readFile(new URL('../lib/oge-vault-cutover-guard.js', import.meta.url), 'utf8');
  const backup = await readFile(new URL('../app/api/backup/route.js', import.meta.url), 'utf8');
  const extension = await readFile(new URL('../app/api/extension/quick-note/route.js', import.meta.url), 'utf8');
  const legacyNotes = await readFile(new URL('../app/api/notes/route.js', import.meta.url), 'utf8');
  assert.match(helper, /OGE_VAULT_CUTOVER_GUARD_PREVIEW === 'true'/);
  assert.match(helper, /OGE_VAULT_MAIN_PREVIEW !== 'true'/);
  assert.match(helper, /OGE_VAULT_HYBRID_DRAFT_PREVIEW !== 'true'/);
  assert.doesNotMatch(helper, /collection\('notes'\)|commitVaultNoteBatch\(/);
  assert.match(backup, /inspectLegacyCutoverForOwner/);
  assert.match(extension, /inspectLegacyCutoverForOwner/);
  assert.match(extension, /\{ extensionTokenHash: tokenHash \}, \{ session \}/);
  assert.doesNotMatch(legacyNotes, /OGE_VAULT_CUTOVER_GUARD_PREVIEW/);
});

test('Phase D every known legacy content endpoint is guarded before MongoDB access', async () => {
  const cases = [
    ['notes', ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']],
    ['quick-notes', ['GET', 'POST', 'PUT', 'DELETE']],
    ['personal-quick-notes', ['GET', 'POST', 'PUT', 'DELETE']],
    ['revision', ['GET', 'POST']],
    ['revision-history', ['GET', 'POST']],
    ['backup', ['GET', 'POST']],
    ['notes/cleanup', ['POST']],
  ];
  for (const [route, methods] of cases) {
    const source = await readFile(new URL('../app/api/' + route + '/route.js', import.meta.url), 'utf8');
    for (const [index, method] of methods.entries()) {
      const start = source.indexOf('export async function ' + method + '(');
      const end = index + 1 < methods.length
        ? source.indexOf('export async function ' + methods[index + 1] + '(', start + 1)
        : source.length;
      assert.ok(start >= 0, route + ' ' + method);
      const body = source.slice(start, end < 0 ? source.length : end);
      assert.match(body, /inspectLegacyCutoverForOwner\(/, route + ' ' + method);
      assert.match(body, /if \(cutover\.blocked\) return legacyCutoverBlockedResponse\(cutover\)/,
        route + ' ' + method);
    }
    assert.doesNotMatch(source, /process\.env\.OGE_VAULT_CUTOVER_GUARD_PREVIEW = 'true'/);
  }
});

test('Phase D transactional legacy writers have a second owner-scoped preflight in the same session', async () => {
  const cases = [
    ['notes', 4], ['quick-notes', 3], ['personal-quick-notes', 3],
    ['revision', 1], ['revision-history', 1], ['backup', 2],
  ];
  for (const [route, expected] of cases) {
    const source = await readFile(new URL('../app/api/' + route + '/route.js', import.meta.url), 'utf8');
    const fenced = (source.match(/\{ sessionVersion(?:: ctx\.sessionVersion)? \}, \{ session \}/g) || []).length;
    assert.equal(fenced, expected, route + ' requires transactional cutover checks');
    assert.match(source, /lockedCutover\.blocked/);
  }
  const extension = await readFile(new URL('../app/api/extension/quick-note/route.js', import.meta.url), 'utf8');
  assert.match(extension, /if \(cutover\.blocked\) return legacyCutoverBlockedResponse\(cutover\)/);
  assert.match(extension, /\{ extensionTokenHash: tokenHash \}, \{ session \}/);
});
