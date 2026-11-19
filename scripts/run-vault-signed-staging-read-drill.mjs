#!/usr/bin/env node
/**
 * E16 / M84 — real, deliberately operator-initiated staging READ-ONLY drill.
 * Two private Playwright storage-state files each supply a pre-authenticated
 * staging session. The script NEVER runs OAuth login, POSTs Notes, enables
 * writes, modifies user data, or claims two physical devices were verified.
 *
 * Requires independently provisioned protected session-state files and
 * precreated PRIVATE output directories; do not commit/share their contents.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { request } from '@playwright/test';
import {
  checkVaultLiveAcceptanceDrillGuard,
  executeVaultLiveAcceptanceReadOnlyDrill,
} from '../lib/oge-vault-live-acceptance-drill.js';

const env = process.env;
const sessionA = env.OGE_VAULT_M84_DEVICE_A_STORAGE_STATE;
const sessionB = env.OGE_VAULT_M84_DEVICE_B_STORAGE_STATE;
const reportDir = env.OGE_VAULT_M84_OBSERVATION_OUTPUT_DIR;
const challengeDir = env.OGE_VAULT_M84_CHALLENGE_OUTPUT_DIR;
const statOwned = (s) => Boolean(s && (s.mode & 0o077) === 0 &&
  (typeof process.getuid !== 'function' || s.uid === process.getuid()));
const fail = () => { throw new TypeError('Unsafe signed staging drill input'); };

async function privateDirectory(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) fail();
  const info = await lstat(path);
  if (!info.isDirectory() || !statOwned(info)) fail();
  return info;
}
async function readPrivateSession(path, expectedHost) {
  await privateDirectory(dirname(path));
  const fd = await open(path, constants.O_RDONLY |
    constants.O_NOFOLLOW | (constants.O_NONBLOCK || 0));
  try {
    const start = await fd.stat();
    if (!start.isFile() || start.nlink !== 1 ||
        !statOwned(start) || start.size < 80 ||
        start.size > 32 * 1024) fail();
    const bytes = await fd.readFile();
    const end = await fd.stat();
    if (start.dev !== end.dev || start.ino !== end.ino ||
        start.size !== bytes.length || end.size !== bytes.length ||
        start.mtimeMs !== end.mtimeMs || start.ctimeMs !== end.ctimeMs) fail();
    const state = JSON.parse(new TextDecoder('utf-8', {
      fatal: true,
    }).decode(bytes));
    if (!state || typeof state !== 'object' ||
        Array.isArray(state) || !Array.isArray(state.cookies) ||
        !Array.isArray(state.origins) || state.origins.length !== 0 ||
        state.cookies.length < 1 || state.cookies.length > 15 ||
        Object.keys(state).sort().join(',') !== 'cookies,origins') fail();

    // Reject any cross-site cookie, browser localStorage or insecure session.
    // Browser states are operator inputs, not proof of OAuth or a device.
    const auth = [];
    for (const cookie of state.cookies) {
      if (!cookie || typeof cookie !== 'object' ||
          cookie.domain !== expectedHost ||
          cookie.secure !== true ||
          cookie.httpOnly !== true ||
          cookie.path !== '/' ||
          typeof cookie.name !== 'string' ||
          typeof cookie.value !== 'string' ||
          cookie.value.length < 10 ||
          cookie.value.length > 8192) fail();
      if (/^(?:__Secure-)?(?:authjs|next-auth)\.session-token(?:\.\d+)?$/.test(
        cookie.name))
        auth.push(cookie.name + '=' + cookie.value);
    }
    if (auth.length < 1 || auth.length > 8) fail();
    return {
      state,
      // Compare two session bearer values without disclosing them.
      sessionFingerprint: createHash('sha256')
        .update(auth.sort().join('\n')).digest('hex'),
    };
  } finally { await fd.close(); }
}
async function privateOutput(path, contents) {
  const fd = await open(path, constants.O_CREAT | constants.O_EXCL |
    constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await fd.writeFile(JSON.stringify(contents, null, 2) + '\n'); }
  finally { await fd.close(); }
}

async function run() {
  if (!checkVaultLiveAcceptanceDrillGuard(env) ||
      typeof sessionA !== 'string' || !isAbsolute(sessionA) ||
      typeof sessionB !== 'string' || !isAbsolute(sessionB) ||
      sessionA === sessionB ||
      typeof reportDir !== 'string' || !isAbsolute(reportDir) ||
      typeof challengeDir !== 'string' || !isAbsolute(challengeDir) ||
      reportDir === challengeDir ||
      [dirname(sessionA), dirname(sessionB)].includes(reportDir) ||
      [dirname(sessionA), dirname(sessionB)].includes(challengeDir)) fail();
  await privateDirectory(reportDir);
  await privateDirectory(challengeDir);
  const host = new URL(env.OGE_STAGING_URL).hostname;
  const first = await readPrivateSession(sessionA, host);
  const second = await readPrivateSession(sessionB, host);
  if (first.sessionFingerprint === second.sessionFingerprint) fail();

  const states = { 'device-a': first.state, 'device-b': second.state };
  const invoke = async (slot, challenge) => {
    const context = await request.newContext({
      baseURL: env.OGE_STAGING_URL,
      storageState: states[slot],
      extraHTTPHeaders: { origin: env.OGE_STAGING_URL },
      timeout: 15000,
      ignoreHTTPSErrors: false,
    });
    try {
      const response = await context.post(
        '/api/vault/acceptance/signed-device-read', {
          data: { challenge, deviceSlot: slot },
          maxRedirects: 0, timeout: 15000, failOnStatusCode: false,
        });
      const type = response.headers()['content-type'] || '';
      if (response.status() !== 200 || !/^application\/json(?:\s*;|$)/i.test(type))
        fail();
      const raw = await response.body();
      if (raw.length < 64 || raw.length > 8192) fail();
      return {
        status: response.status(), contentType: type,
        json: JSON.parse(new TextDecoder('utf-8', {
          fatal: true,
        }).decode(raw)),
      };
    } finally { await context.dispose(); }
  };

  const result = await executeVaultLiveAcceptanceReadOnlyDrill({
    env, invoke,
  });
  // Do not output raw HTTP bodies, session bearer cookies or challenges.
  // Never overwrite an existing operator evidence record.
  await privateOutput(join(reportDir, 'm84-observations.json'), result.pair);
  await privateOutput(join(challengeDir, 'm84-challenges.json'),
    result.operatorChallenges);
  console.log(JSON.stringify(result.safeSummary, null, 2));
}

try {
  await run();
  // A successful read-only staging drill is still NOT live two-device
  // OAuth acceptance, production signoff or authority to unlock.
  process.exitCode = 2;
} catch {
  console.error('BLOCKED: isolated private staging signed-session read-only drill incomplete or unsafe.');
  process.exitCode = 1;
}
