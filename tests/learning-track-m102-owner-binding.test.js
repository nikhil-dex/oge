import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  m102OwnerBindingServerEnabled, m102OwnerBindingTag,
  m102OperatorBindingEnabled, executeM102StagingOwnerBinding,
} from '../lib/oge-learning-track-m102-owner-binding.js';
import { executeM101ReadOnlyStagingObservation } from '../lib/oge-learning-track-m101-readonly-acceptance.js';

const trackId = '9b044299-28c7-44ad-9d66-3f6b77e956a4';
const videoId = 'abc12345678';
const noteId = 'c96a716d-125b-43e9-96dc-992a9b6d34cf';
const linkId = '17c44540-fd34-465c-946e-a1e1def5ff3c';
const version = '78435e38-57a7-4e7b-8dc0-c0eaa942788d';
const env = {
  OGE_LEARNING_TRACK_M101_READ_ONLY_ACCEPTANCE: 'YES_ISOLATED_TWO_SESSION_READS_NO_WRITES',
  OGE_LEARNING_TRACK_M101_OPERATOR_ACK: 'DISPOSABLE_OWNER_TRACK_AND_NOTE_ONLY',
  OGE_LEARNING_TRACK_M101_RUN_ID: version,
  OGE_LEARNING_TRACK_M101_TRACK_ID: trackId,
  OGE_LEARNING_TRACK_M101_VIDEO_ID: videoId,
  OGE_LEARNING_TRACK_M102_OWNER_BINDING_PREVIEW: 'true',
  OGE_LEARNING_TRACK_M102_OPERATOR_ACK: 'YES_COMPARE_EXISTING_DISPOSABLE_SESSIONS_READ_ONLY',
  OGE_LEARNING_TRACK_M102_OWNER_BINDING_KEY: 'a9'.repeat(32),
  OGE_STAGING_URL: 'https://staging.oge-example.org',
  AUTH_URL: 'https://staging.oge-example.org',
  OGE_VAULT_BASE_URL: 'https://staging.oge-example.org',
  MONGODB_DB: 'oge_vault_restore_staging_disposable',
};
const identity = { ownerId: 'disposable-owner', sessionVersion: version };
const owner = { vault: {
  status: 'connected', repoId: 927, installationId: 735,
  githubAccountId: '12345', githubLogin: 'disposable-account', repoName: 'ogenotes-vault',
} };
const fakeReadiness = () => true;
const reply = (tag) => ({
  status: 200, noStore: true,
  data: { bindingSha256: tag, status: 'OWNER_VAULT_SESSION_MAPPING_OBSERVED_HOLD',
    releaseAuthorized: false },
});
function core() {
  return {
    status: 'TWO_SESSION_LINK_READS_OBSERVED_HOLD',
    productionReady: false, noteOrLinkWritesPerformed: false,
    githubRetryPerformed: false, restorationAuthorized: false,
    canReleaseQuarantine: false,
    physicalDeviceProvenanceVerified: false,
    oauthIssuerIndependentlyVerified: false,
  };
}
const run = (invokeBinding, executeM101 = async () => core(), scoped = env) =>
  executeM102StagingOwnerBinding({ env: scoped, invokeBinding, executeM101,
    readiness: fakeReadiness });

test('M102 HMAC is secret-keyed, run/owner/session/repository scoped, never raw identity', () => {
  assert.equal(m102OwnerBindingServerEnabled(env, fakeReadiness), true);
  assert.equal(m102OperatorBindingEnabled(env, fakeReadiness), true);
  const tag = m102OwnerBindingTag(identity, owner, env, fakeReadiness);
  assert.match(tag, /^[a-f0-9]{64}$/);
  assert.equal(tag, m102OwnerBindingTag(identity, owner, env, fakeReadiness));
  assert.notEqual(tag, m102OwnerBindingTag({ ...identity, ownerId: 'another-owner' }, owner, env, fakeReadiness));
  assert.notEqual(tag, m102OwnerBindingTag({ ...identity, sessionVersion: 0 }, owner, env, fakeReadiness));
  assert.notEqual(tag, m102OwnerBindingTag(identity,
    { vault: { ...owner.vault, repoId: owner.vault.repoId + 1 } }, env, fakeReadiness));
  assert.notEqual(tag, m102OwnerBindingTag(identity, owner,
    { ...env, OGE_LEARNING_TRACK_M101_RUN_ID: trackId }, fakeReadiness));
  assert.notEqual(tag, m102OwnerBindingTag(identity, owner,
    { ...env, OGE_LEARNING_TRACK_M102_OWNER_BINDING_KEY: 'b7'.repeat(32) }, fakeReadiness));
  assert.ok(!tag.includes(identity.ownerId));
  assert.ok(!tag.includes(owner.vault.githubLogin));
});

test('M102 remains independently default-off and refuses unsafe staging/invalid owners', () => {
  assert.equal(m102OwnerBindingServerEnabled({ ...env, OGE_LEARNING_TRACK_M102_OWNER_BINDING_KEY: '' }, fakeReadiness), false);
  assert.equal(m102OwnerBindingServerEnabled({ ...env, OGE_LEARNING_TRACK_M102_OWNER_BINDING_PREVIEW: 'false' }, fakeReadiness), false);
  assert.equal(m102OperatorBindingEnabled({ ...env, OGE_LEARNING_TRACK_M102_OPERATOR_ACK: '' }, fakeReadiness), false);
  for (const change of [
    { OGE_VAULT_CUTOVER_GUARD_PREVIEW: 'true' },
    { MONGODB_DB: 'oge_notes' },
    { OGE_STAGING_URL: 'https://app.oge-example.org', AUTH_URL: 'https://app.oge-example.org', OGE_VAULT_BASE_URL: 'https://app.oge-example.org' },
    { AUTH_URL: 'https://other.example.org' },
    { OGE_LEARNING_TRACK_M101_OPERATOR_ACK: '' },
  ]) assert.equal(m102OwnerBindingServerEnabled({ ...env, ...change }, fakeReadiness), false);
  for (const invalid of [
    { ...owner, vault: { ...owner.vault, repoId: 0 } },
    { ...owner, vault: { ...owner.vault, status: 'revoked' } },
    { ...owner, vault: { ...owner.vault, githubAccountId: 'invalid' } },
    { ...owner, vault: { ...owner.vault, repoName: 'foreign-repo' } },
  ]) assert.throws(() => m102OwnerBindingTag(identity, invalid, env, fakeReadiness), TypeError);
});

test('M102 compares same-owner proof before and after M101 eight read-only checks', async () => {
  const tag = m102OwnerBindingTag(identity, owner, env, fakeReadiness);
  const order = [];
  const binding = async (slot) => { order.push('proof:' + slot); return reply(tag); };
  const read = async (slot, path) => {
    order.push('read:' + slot);
    if (path === '/api/learning-tracks')
      return { status: 200, noStore: true, data: {
        tracks: [{ id: trackId }], noteLinkingEnabled: true,
      } };
    if (path.includes('mode=verify'))
      return { status: 200, noStore: true, data: {
        status: 'present', warning: 'Point-in-time private GitHub read only.',
      } };
    return { status: 200, noStore: true, data: {
      links: [{ trackId, videoId, noteId, linkId }], warning: 'Stale links can remain.',
    } };
  };
  const report = await run(binding, () => executeM101ReadOnlyStagingObservation({
    env, readiness: fakeReadiness, invoke: read,
  }));
  assert.equal(order.length, 12);
  assert.deepEqual(order.slice(0,2), ['proof:device-a', 'proof:device-b']);
  assert.deepEqual(order.slice(-2), ['proof:device-a', 'proof:device-b']);
  assert.equal(report.status, 'SAME_ACTIVE_OWNER_VAULT_MAPPING_OBSERVED_HOLD');
  assert.equal(report.sameActiveOwnerVaultMappingObservedAtChecks, true);
  assert.equal(report.githubNoteVerificationReads, 2);
  assert.equal(report.productionReady, false);
  assert.equal(report.actualOAuthIssuerVerified, false);
  assert.equal(report.twoPhysicalDevicesIndependentlyVerified, false);
  assert.equal(report.independentSecurityReviewCompleted, false);
  for (const secret of [identity.ownerId, noteId, linkId, trackId, videoId,
    owner.vault.githubLogin, tag, env.OGE_LEARNING_TRACK_M102_OWNER_BINDING_KEY])
    assert.ok(!JSON.stringify(report).includes(secret));
});

test('M102 rejects different owner, changed mapping mid-run, revocation, forged release and faults', async () => {
  const tag = m102OwnerBindingTag(identity, owner, env, fakeReadiness);
  const other = m102OwnerBindingTag({ ...identity, ownerId: 'different-owner' },
    owner, env, fakeReadiness);
  for (const sequence of [[tag, other], [tag,tag,other], [tag,tag,tag,other]]) {
    let n = 0;
    await assert.rejects(run(async () => reply(sequence[n++])), TypeError);
  }
  await assert.rejects(run(async () => { throw new Error('PRIVATE_COOKIE_VALUE'); }),
    (e) => e instanceof TypeError && !e.message.includes('PRIVATE_COOKIE_VALUE'));
  await assert.rejects(run(async () => ({ status: 401, noStore: true,
    data: { error: 'revoked' } })), TypeError);
  await assert.rejects(run(async () => ({ ...reply(tag), noStore: false })), TypeError);
  await assert.rejects(run(async () => ({ ...reply(tag), data: {
    ...reply(tag).data, releaseAuthorized: true,
  } })), TypeError);
  await assert.rejects(run(async () => reply(tag), async () => ({
    ...core(), productionReady: true,
  })), TypeError);
});

test('M102 endpoint and operator stay read-only, signed-owner, isolated and key never in client bundle', async () => {
  const route = await readFile(new URL('../app/api/learning-tracks/acceptance/owner-binding/route.js', import.meta.url), 'utf8');
  const script = await readFile(new URL('../scripts/run-learning-tracks-m101-readonly.mjs', import.meta.url), 'utf8');
  assert.match(route, /m102OwnerBindingServerEnabled\(env\)/);
  assert.match(route, /await auth\(\)/);
  assert.match(route, /ownerMutationFilter\(identity\.ownerId/);
  assert.match(route, /'learning-track-m102-binding'/);
  assert.match(route, /'Cache-Control': 'private, no-store'/);
  assert.match(route, /m102OwnerBindingTag\(identity, account, env\)/);
  assert.match(route, /request\.headers\.get\('origin'\)/);
  assert.match(script, /executeM102StagingOwnerBinding/);
  assert.match(script, /doOwnerBinding \?/);
  assert.match(script, /ownerBindingPath/);
  assert.doesNotMatch(route + script, /\.post\(|\.put\(|\.delete\(|saveVaultNote|commitVaultNoteBatch/);
  assert.doesNotMatch(script, /OGE_LEARNING_TRACK_M102_OWNER_BINDING_KEY/);
});
