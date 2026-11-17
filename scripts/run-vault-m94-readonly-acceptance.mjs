#!/usr/bin/env node
/**
 * E26/M94: operator-only actual signed-staging READ-ONLY observation drill.
 * This code DOES NOT acquire OAuth sessions, prove physical devices, induce
 * GitHub writes/failures, restore Notes or release quarantines.
 *
 * Requires two separately captured private signed-session Playwright states
 * and two local synthetic/disposable owner Vault current-resource JSON files.
 * All four files are owned 0600 regular no-symlink files under owned 0700
 * directories. No private file, token, Note content or source hash is logged.
 * EXIT 2 = read-only observations recorded, INCOMPLETE acceptance (HOLD).
 * EXIT 1 = blocked/inconclusive. Never uses exit 0 as production signoff.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { request } from '@playwright/test';
import {
  checkVaultM94ReadOnlyAcceptanceGuard,
  executeVaultM94ReadOnlyAcceptance,
} from '../lib/oge-vault-m94-read-only-acceptance.js';

const env = process.env;
const BLOCK = () => { throw new TypeError('Unsafe M94 read-only staging input'); };
const owned = s => Boolean(s && (s.mode & 0o077) === 0 &&
  (typeof process.getuid !== 'function' || s.uid === process.getuid()));
async function privateRegular(path, min, max) {
  if (typeof path !== 'string' || !isAbsolute(path)) BLOCK();
  const dir = await lstat(dirname(path));
  if (!dir.isDirectory() || !owned(dir)) BLOCK();
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW |
    (constants.O_NONBLOCK || 0));
  try {
    const before = await fd.stat();
    if (!before.isFile() || before.nlink !== 1 || !owned(before) ||
        before.size < min || before.size > max) BLOCK();
    const bytes = await fd.readFile();
    const after = await fd.stat();
    if (after.dev !== before.dev || after.ino !== before.ino ||
        after.size !== before.size || bytes.length !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs) BLOCK();
    return bytes;
  } finally { await fd.close(); }
}
function signedState(raw, hostname) {
  const state = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  if (!state || typeof state !== 'object' || Array.isArray(state) ||
      Object.keys(state).sort().join(',') !== 'cookies,origins' ||
      !Array.isArray(state.origins) || state.origins.length !== 0 ||
      !Array.isArray(state.cookies) ||
      state.cookies.length < 1 || state.cookies.length > 15) BLOCK();
  const tokens = [];
  for (const cookie of state.cookies) {
    if (!cookie || typeof cookie !== 'object' ||
        cookie.domain !== hostname || cookie.path !== '/' ||
        cookie.secure !== true || cookie.httpOnly !== true ||
        typeof cookie.name !== 'string' ||
        typeof cookie.value !== 'string' ||
        cookie.value.length < 10 || cookie.value.length > 8192) BLOCK();
    if (/^(?:__Secure-)?(?:authjs|next-auth)\.session-token(?:\.\d+)?$/.test(
      cookie.name)) tokens.push(cookie.name + '=' + cookie.value);
  }
  if (tokens.length < 1 || tokens.length > 8) BLOCK();
  return {
    state,
    fingerprint: createHash('sha256').update(tokens.sort().join('\n'))
      .digest('hex'),
  };
}
function localFile(bytes) {
  return {
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer.slice(
      bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}
async function readBounded(response, maxBytes) {
  if (response.status() !== 200) BLOCK(); // No OAuth redirects or retries
  const headers = response.headers();
  if (!/^application\/json(?:\s*;|$)/i.test(
    headers['content-type'] || '')) BLOCK();
  if (headers['content-length'] !== undefined &&
      (!/^\d+$/.test(headers['content-length']) ||
       Number(headers['content-length']) > maxBytes)) BLOCK();
  const raw = await response.body();
  if (raw.length < 64 || raw.length > maxBytes) BLOCK();
  return {
    contentType: headers['content-type'],
    json: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)),
    raw,
  };
}
async function run() {
  if (!checkVaultM94ReadOnlyAcceptanceGuard(env)) BLOCK();
  const paths = [
    env.OGE_VAULT_M94_DEVICE_A_STORAGE_STATE,
    env.OGE_VAULT_M94_DEVICE_B_STORAGE_STATE,
    env.OGE_VAULT_M94_HISTORICAL_BACKUP_FILE,
    env.OGE_VAULT_M94_CURRENT_REFERENCE_FILE,
  ];
  if (paths.some(p => typeof p !== 'string' || !isAbsolute(p)) ||
      new Set(paths).size !== 4) BLOCK();
  let a, b, historical, current;
  const contexts = {};
  try {
    // Read only operator-owned locally protected files. Never print secrets.
    [a, b, historical, current] = await Promise.all([
      privateRegular(paths[0], 80, 32 * 1024),
      privateRegular(paths[1], 80, 32 * 1024),
      privateRegular(paths[2], 256, 8 * 1024 * 1024),
      privateRegular(paths[3], 256, 8 * 1024 * 1024),
    ]);
    const host = new URL(env.OGE_STAGING_URL).hostname;
    const stateA = signedState(a, host);
    const stateB = signedState(b, host);
    if (stateA.fingerprint === stateB.fingerprint) BLOCK();
    contexts['device-a'] = await request.newContext({
      baseURL: env.OGE_STAGING_URL,
      storageState: stateA.state,
      extraHTTPHeaders: { origin: env.OGE_STAGING_URL },
      timeout: 15000, ignoreHTTPSErrors: false,
    });
    contexts['device-b'] = await request.newContext({
      baseURL: env.OGE_STAGING_URL,
      storageState: stateB.state,
      extraHTTPHeaders: { origin: env.OGE_STAGING_URL },
      timeout: 15000, ignoreHTTPSErrors: false,
    });
    const invokeSignedRead = async (slot, challenge) => {
      if (!['device-a', 'device-b'].includes(slot) ||
          !/^[a-f0-9]{64}$/.test(challenge)) BLOCK();
      const response = await contexts[slot].post(
        '/api/vault/acceptance/signed-device-read', {
          data: { deviceSlot: slot, challenge },
          maxRedirects: 0, timeout: 15000, failOnStatusCode: false,
        });
      const parsed = await readBounded(response, 8192);
      return {
        status: response.status(), contentType: parsed.contentType,
        json: parsed.json,
      };
    };
    const invokeSourceRead = async (url, init) => {
      // The only permitted recovery network actions. No arbitrary URL and
      // no Note content, file body or custom user-directed server API.
      if (![
        '/api/vault/backup-current-resources/history-check',
        '/api/vault/backup-current-resources/source-check',
      ].includes(url) || init?.method !== 'POST' ||
          init.credentials !== 'same-origin' || init.cache !== 'no-store' ||
          typeof init.body !== 'string' ||
          Buffer.byteLength(init.body) > 512) BLOCK();
      const response = await contexts['device-a'].post(url, {
        data: JSON.parse(init.body), maxRedirects: 0,
        timeout: 15000, failOnStatusCode: false,
      });
      const parsed = await readBounded(response, 4096);
      // Existing M89/M92 strict response validators run on the returned
      // standard Response. Do not expose provider raw response to output.
      return new Response(parsed.raw, {
        status: 200,
        headers: {
          'content-type': parsed.contentType,
          'content-length': String(parsed.raw.length),
        },
      });
    };
    const result = await executeVaultM94ReadOnlyAcceptance({
      env,
      backupFile: localFile(historical),
      referenceFile: localFile(current),
      invokeSignedRead, invokeSourceRead,
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await Promise.all(Object.values(contexts).map(c => c.dispose()));
    for (const raw of [a, b, historical, current]) raw?.fill(0);
  }
}
try {
  await run();
  process.exitCode = 2; // Observations only, NOT completed acceptance
} catch {
  console.error('BLOCKED: M94 private signed staging read-only acceptance incomplete; no automatic retry.');
  process.exitCode = 1;
}
