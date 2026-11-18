import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  m101ReadOnlyStagingGuard, executeM101ReadOnlyStagingObservation,
} from '../lib/oge-learning-track-m101-readonly-acceptance.js';

const trackId = '9b044299-28c7-44ad-9d66-3f6b77e956a4';
const noteId = 'c96a716d-125b-43e9-96dc-992a9b6d34cf';
const videoId = 'abc12345678';
const env = {
  OGE_LEARNING_TRACK_M101_READ_ONLY_ACCEPTANCE: 'YES_ISOLATED_TWO_SESSION_READS_NO_WRITES',
  OGE_LEARNING_TRACK_M101_OPERATOR_ACK: 'DISPOSABLE_OWNER_TRACK_AND_NOTE_ONLY',
  OGE_LEARNING_TRACK_M101_RUN_ID: '78435e38-57a7-4e7b-8dc0-c0eaa942788d',
  OGE_LEARNING_TRACK_M101_TRACK_ID: trackId,
  OGE_LEARNING_TRACK_M101_VIDEO_ID: videoId,
  OGE_STAGING_URL: 'https://staging.oge-example.org',
  AUTH_URL: 'https://staging.oge-example.org',
  OGE_VAULT_BASE_URL: 'https://staging.oge-example.org',
  MONGODB_DB: 'oge_vault_restore_staging_disposable',
};
const fakeReadiness = () => true;
const wrapped = (data) => ({ status: 200, noStore: true, data });
function makeInvoke(overrides = {}) {
  const calls = [];
  const invoke = async (slot, path) => {
    calls.push({ slot, path });
    if (overrides.failAt === calls.length)
      throw new Error('SECRET_POTENTIAL_PROVIDER_BODY');
    let data;
    if (path === '/api/learning-tracks') data = {
      tracks: [{ id: trackId }], noteLinkingEnabled: true,
    };
    else if (path.includes('mode=verify')) data = {
      status: 'present', warning: 'Point-in-time private GitHub read only.',
    };
    else data = {
      links: [{ trackId, videoId, noteId }], warning: 'Stale links can remain.',
    };
    if (overrides.replace && calls.length === overrides.at)
      data = overrides.replace;
    const reply = wrapped(data);
    if (overrides.noStoreAt === calls.length) reply.noStore = false;
    return reply;
  };
  return { invoke, calls };
}
const run = (invoke, input = env) => executeM101ReadOnlyStagingObservation({
  env: input, invoke, readiness: fakeReadiness,
});

test('M101 opt-in, isolated HTTPS staging and dangerous-write flags fail closed', () => {
  assert.equal(m101ReadOnlyStagingGuard(env), false); // Synthetic CI has no real staging credentials
  assert.equal(m101ReadOnlyStagingGuard(env, fakeReadiness), true);
  for (const change of [
    { OGE_STAGING_URL: 'http://staging.oge-example.org' },
    { AUTH_URL: 'https://elsewhere.example' },
    { OGE_STAGING_URL: 'https://staging.oge-example.org/' },
    { OGE_STAGING_URL: 'https://localhost' },
    { MONGODB_DB: 'oge_notes' },
    { OGE_LEARNING_TRACK_M101_RUN_ID: 'not-a-uuid' },
    { OGE_LEARNING_TRACK_M101_TRACK_ID: 'invalid' },
    { OGE_LEARNING_TRACK_M101_VIDEO_ID: 'invalid' },
    { OGE_LEARNING_TRACK_M101_READ_ONLY_ACCEPTANCE: '' },
    { OGE_LEARNING_TRACK_M101_OPERATOR_ACK: '' },
    { OGE_VAULT_CUTOVER_GUARD_PREVIEW: 'true' },
    { OGE_VAULT_BACKUP_IMPORT_COMMIT_PREVIEW: 'true' },
    { OGE_VAULT_STANDALONE_RESTORE_WRITE_ACK: 'unsafe' },
    { OGE_ACCOUNT_DELETION_ENABLED: 'true' },
  ]) assert.equal(m101ReadOnlyStagingGuard({ ...env, ...change }, fakeReadiness), false,
    JSON.stringify(change));
});

test('M101 two distinct sessions require 8 strictly ordered GET observations, no Note content report', async () => {
  const { invoke, calls } = makeInvoke();
  const report = await run(invoke);
  assert.deepEqual(calls.map(({ slot }) => slot),
    ['device-a','device-b','device-a','device-b','device-a','device-b','device-a','device-b']);
  assert.equal(calls.length, 8);
  assert.equal(report.status, 'TWO_SESSION_LINK_READS_OBSERVED_HOLD');
  assert.equal(report.stagingSessionsObserved, 2);
  assert.equal(report.ownerTriggeredGithubNoteChecks, 2);
  assert.equal(report.productionReady, false);
  assert.equal(report.physicalDeviceProvenanceVerified, false);
  assert.equal(report.oauthIssuerIndependentlyVerified, false);
  assert.equal(report.concurrentWriteConflictsVerified, false);
  assert.equal(report.noteOrLinkWritesPerformed, false);
  assert.match(report.runBindingSha256, /^[a-f0-9]{64}$/);
  const reportText = JSON.stringify(report);
  assert.ok(!reportText.includes(noteId));
  assert.ok(!reportText.includes(trackId));
  assert.ok(!reportText.includes(videoId));
  assert.ok(!reportText.includes('PRIVATE NOTE'));
});

test('M101 rejects another-device relink, missing Note and forged release fields', async () => {
  const changed = {
    links: [{ trackId, videoId, noteId: '2ad62d6a-18e5-4af0-bc97-0dd85d6c2a4e' }],
    warning: 'Changed',
  };
  await assert.rejects(run(makeInvoke({ at: 4, replace: changed }).invoke), TypeError);
  await assert.rejects(run(makeInvoke({ at: 8, replace: changed }).invoke), TypeError);
  await assert.rejects(run(makeInvoke({ at: 5,
    replace: { status: 'missing', warning: 'Point-in-time missing.' } }).invoke), TypeError);
  await assert.rejects(run(makeInvoke({ at: 5,
    replace: { status: 'present', warning: 'Point-in-time read.', canRestore: true } }).invoke),
  TypeError);
  await assert.rejects(run(makeInvoke({ at: 1, replace: {
    tracks: [{ id: 'another-owner-track' }], noteLinkingEnabled: true,
  } }).invoke), TypeError);
});

test('M101 provider errors, missing no-store and partial responses cause HOLD without logging details', async () => {
  await assert.rejects(run(makeInvoke({ failAt: 5 }).invoke),
    (e) => e instanceof TypeError && !e.message.includes('SECRET_POTENTIAL_PROVIDER_BODY'));
  await assert.rejects(run(makeInvoke({ noStoreAt: 6 }).invoke), TypeError);
  await assert.rejects(run(async () => ({ status: 429, noStore: true,
    data: { error: 'rate limit' } })), TypeError);
});

test('M101 operator CLI never uses HTTP writes and exits HOLD even after observed reads', async () => {
  const cli = await readFile(new URL('../scripts/run-learning-tracks-m101-readonly.mjs', import.meta.url), 'utf8');
  const packageJson = await readFile(new URL('../package.json', import.meta.url), 'utf8');
  assert.match(cli, /O_RDONLY \| constants\.O_NOFOLLOW/);
  assert.match(cli, /ownerOnly/);
  assert.match(cli, /first\.fingerprint === second\.fingerprint/);
  assert.match(cli, /maxRedirects: 0/);
  assert.match(cli, /response\.url\(\) !== env\.OGE_STAGING_URL/);
  assert.match(cli, /redactedReport/);
  assert.match(cli, /process\.exitCode = 2/);
  assert.doesNotMatch(cli, /contexts\[slot\]\.post\(|\.put\(|\.delete\(/);
  assert.match(packageJson, /vault:staging:m101-learning-track-readonly/);
});
