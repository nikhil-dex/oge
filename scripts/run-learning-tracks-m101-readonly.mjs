#!/usr/bin/env node
/**
 * M101 operator-only REAL staging HTTP reads through two independently supplied
 * signed-session Playwright storage-state files. No OAuth login, physical device
 * provenance proof, writes, provider fault injection, retry, or release approval.
 *
 * Exit 2 = redacted READ observations obtained but acceptance HOLD.
 * Exit 1 = blocked/inconclusive. Never exit 0 for production approval.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { request } from '@playwright/test';
import {
  executeM101ReadOnlyStagingObservation, m101ReadOnlyStagingGuard,
} from '../lib/oge-learning-track-m101-readonly-acceptance.js';
import {
  m102OperatorBindingEnabled, executeM102StagingOwnerBinding,
} from '../lib/oge-learning-track-m102-owner-binding.js';

const env = process.env;
const BLOCK = () => { throw new TypeError('Unsafe M101 staging input'); };
const ownerOnly = (st) => Boolean(st && (st.mode & 0o077) === 0 &&
  (typeof process.getuid !== 'function' || st.uid === process.getuid()));

async function ownedParent(path) {
  if (!isAbsolute(path)) BLOCK();
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || !ownerOnly(parent)) BLOCK();
}
async function protectedFile(path) {
  if (typeof path !== 'string') BLOCK();
  await ownedParent(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW |
    (constants.O_NONBLOCK || 0));
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || !ownerOnly(before) ||
        before.size < 80 || before.size > 32768) BLOCK();
    const raw = await file.readFile();
    const after = await file.stat();
    if (raw.length !== before.size || before.dev !== after.dev ||
        before.ino !== after.ino || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) BLOCK();
    return raw;
  } finally { await file.close(); }
}
function storageState(raw, hostname) {
  const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      Object.keys(data).sort().join(',') !== 'cookies,origins' ||
      !Array.isArray(data.origins) || data.origins.length !== 0 ||
      !Array.isArray(data.cookies) ||
      data.cookies.length < 1 || data.cookies.length > 15) BLOCK();
  const signedCookies = [];
  for (const cookie of data.cookies) {
    if (!cookie || typeof cookie !== 'object' || cookie.domain !== hostname ||
        cookie.path !== '/' || cookie.secure !== true ||
        cookie.httpOnly !== true || typeof cookie.name !== 'string' ||
        typeof cookie.value !== 'string' || cookie.value.length < 10 ||
        cookie.value.length > 8192) BLOCK();
    if (/^(?:__Secure-)?(?:authjs|next-auth)\.session-token(?:\.\d+)?$/.test(
      cookie.name)) signedCookies.push(cookie.name + '=' + cookie.value);
  }
  if (signedCookies.length < 1 || signedCookies.length > 8) BLOCK();
  return {
    state: data,
    fingerprint: createHash('sha256').update(signedCookies.sort().join('\n'))
      .digest('hex'),
  };
}
async function redactedReport(data) {
  const path = env.OGE_LEARNING_TRACK_M101_PRIVATE_REPORT_FILE;
  if (!path) return;
  await ownedParent(path);
  const file = await open(path, constants.O_CREAT | constants.O_EXCL |
    constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    const raw = JSON.stringify(data, null, 2) + '\n';
    if (Buffer.byteLength(raw) > 8192) BLOCK();
    await file.writeFile(raw);
    await file.sync();
  } finally { await file.close(); }
}

async function main() {
  if (!m101ReadOnlyStagingGuard(env)) BLOCK();
  const doOwnerBinding = env.OGE_LEARNING_TRACK_M102_OWNER_BINDING_PREVIEW === 'true';
  if (doOwnerBinding && !m102OperatorBindingEnabled(env)) BLOCK();
  const paths = [
    env.OGE_LEARNING_TRACK_M101_DEVICE_A_STORAGE_STATE,
    env.OGE_LEARNING_TRACK_M101_DEVICE_B_STORAGE_STATE,
  ];
  if (paths.some((p) => typeof p !== 'string' || !isAbsolute(p)) ||
      paths[0] === paths[1]) BLOCK();
  if (env.OGE_LEARNING_TRACK_M101_PRIVATE_REPORT_FILE) {
    const path = env.OGE_LEARNING_TRACK_M101_PRIVATE_REPORT_FILE;
    if (paths.includes(path)) BLOCK();
    await ownedParent(path);
  }
  let a, b;
  const contexts = {};
  try {
    [a, b] = await Promise.all(paths.map(protectedFile));
    const hostname = new URL(env.OGE_STAGING_URL).hostname;
    const first = storageState(a, hostname);
    const second = storageState(b, hostname);
    if (first.fingerprint === second.fingerprint) BLOCK();

    contexts['device-a'] = await request.newContext({
      baseURL: env.OGE_STAGING_URL, storageState: first.state,
      extraHTTPHeaders: { Origin: env.OGE_STAGING_URL },
      timeout: 15000, ignoreHTTPSErrors: false,
    });
    contexts['device-b'] = await request.newContext({
      baseURL: env.OGE_STAGING_URL, storageState: second.state,
      extraHTTPHeaders: { Origin: env.OGE_STAGING_URL },
      timeout: 15000, ignoreHTTPSErrors: false,
    });
    const ownerBindingPath = '/api/learning-tracks/acceptance/owner-binding?run=' +
      env.OGE_LEARNING_TRACK_M101_RUN_ID;
    const allowedPaths = [
      '/api/learning-tracks',
      '/api/learning-tracks/note-links?trackId=' + env.OGE_LEARNING_TRACK_M101_TRACK_ID,
      '/api/learning-tracks/note-links?mode=verify&trackId=' +
        env.OGE_LEARNING_TRACK_M101_TRACK_ID + '&videoId=' +
        env.OGE_LEARNING_TRACK_M101_VIDEO_ID,
      ...(doOwnerBinding ? [ownerBindingPath] : []),
    ];
    const invoke = async (slot, path) => {
      if (!['device-a', 'device-b'].includes(slot) ||
          !allowedPaths.includes(path)) BLOCK();
      const response = await contexts[slot].get(path, {
        // A private Note verification is a deliberate operator act, not an
        // ambient cross-site GET. No other read endpoint receives this header.
        headers: path.includes('mode=verify&')
          ? { 'X-Oge-Verify-Intent': 'manual' } : {},
        maxRedirects: 0, failOnStatusCode: false, timeout: 15000,
      });
      if (response.url() !== env.OGE_STAGING_URL + path ||
          response.status() !== 200) BLOCK();
      const headers = response.headers();
      if (!/^application\/json(?:\s*;|$)/i.test(headers['content-type'] || '') ||
          !/\bprivate\b/i.test(headers['cache-control'] || '') ||
          !/\bno-store\b/i.test(headers['cache-control'] || '')) BLOCK();
      if (headers['content-length'] !== undefined &&
          (!/^\d+$/.test(headers['content-length']) ||
           Number(headers['content-length']) > 256 * 1024)) BLOCK();
      const raw = await response.body();
      if (raw.length < 2 || raw.length > 256 * 1024) BLOCK();
      const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
      return { status: 200, noStore: true, data };
    };
    const executeM101 = () => executeM101ReadOnlyStagingObservation({ env, invoke });
    // M102 adds four read-only owner/account mapping attestations bracketing
    // M101's eight reads. Never send cookies/owner IDs in the report.
    const report = doOwnerBinding
      ? await executeM102StagingOwnerBinding({
        env, invokeBinding: (slot) => invoke(slot, ownerBindingPath),
        executeM101,
      })
      : await executeM101();
    await redactedReport(report);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await Promise.all(Object.values(contexts).map((c) => c.dispose()));
    a?.fill(0);
    b?.fill(0);
  }
}
try {
  await main();
  process.exitCode = 2;
} catch {
  console.error('BLOCKED: M101 private two-session read-only staging drill incomplete. No automatic retry.');
  process.exitCode = 1;
}
