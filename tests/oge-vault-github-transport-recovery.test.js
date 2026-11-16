import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { vaultGithubRequest, VaultGitHubError } from '../lib/oge-vault-github.js';

const request = (fetcher, method = 'GET') =>
  vaultGithubRequest('/repos/student/ogenotes-vault/git/ref/heads/main', {
    token: 'synthetic-secret-never-log', method, fetcher,
    ...(method === 'GET' ? {} : { body: { sha: 'a'.repeat(40), force: false } }),
  });
const response = (status, body = { ok: true }, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status, headers: { get: (key) => headers[key] ?? null },
  async json() { return body; },
});

test('B7 transient GET network loss retries only the read and returns verified response', async () => {
  let calls = 0;
  const result = await request(async (_url, init) => {
    assert.equal(init.method, 'GET');
    if (++calls === 1) throw new Error('synthetic read network failure');
    return response(200, { object: { sha: 'a'.repeat(40) } });
  });
  assert.equal(result.object.sha, 'a'.repeat(40));
  assert.equal(calls, 2);
});

test('B7 transient GET 502/503/504 retries one time, never indefinitely', async () => {
  for (const failure of [502, 503, 504]) {
    let calls = 0;
    const result = await request(async () => ++calls === 1
      ? response(failure) : response(200, { restored: true }));
    assert.equal(result.restored, true);
    assert.equal(calls, 2);
  }
  let calls = 0;
  await assert.rejects(request(async () => {
    calls++;
    return response(503);
  }), (error) => error instanceof VaultGitHubError && error.status === 503);
  assert.equal(calls, 2);
});

test('B7 GitHub 429 and secondary/primary 403 limits never trigger automatic retry', async () => {
  for (const [status, headers] of [
    [429, {}],
    [403, { 'retry-after': '60' }],
    [403, { 'x-ratelimit-remaining': '0' }],
  ]) {
    let calls = 0;
    await assert.rejects(request(async () => {
      calls++;
      return response(status, null, headers);
    }), (error) => error instanceof VaultGitHubError &&
      error.message === 'github-rate-limited' && error.status === 429);
    assert.equal(calls, 1);
  }
});

test('B7 non-rate-limit auth/permission errors do not retry a GET', async () => {
  for (const [status, code] of [
    [401, 'github-auth-expired'], [403, 'github-permission-denied'],
    [404, 'github-api-error'], [422, 'github-repository-conflict'],
  ]) {
    let calls = 0;
    await assert.rejects(request(async () => {
      calls++;
      return response(status);
    }), (error) => error instanceof VaultGitHubError && error.message === code);
    assert.equal(calls, 1);
  }
});

test('B7 ambiguous GitHub PATCH/POST/PUT/DELETE acknowledgments are NEVER replayed', async () => {
  for (const method of ['PATCH', 'POST', 'PUT', 'DELETE']) {
    let calls = 0;
    await assert.rejects(request(async (_url, init) => {
      assert.equal(init.method, method);
      calls++;
      throw new Error('synthetic lost ACK with auth data');
    }, method), (error) => error instanceof VaultGitHubError &&
      error.message === 'github-network-unavailable');
    assert.equal(calls, 1);

    let serverErrors = 0;
    await assert.rejects(request(async () => {
      serverErrors++;
      return response(503);
    }, method), (error) => error instanceof VaultGitHubError && error.status === 503);
    assert.equal(serverErrors, 1);
  }
});

test('B7 malformed GitHub responses never imply a confirmed read or leak credentials', async () => {
  let calls = 0;
  await assert.rejects(request(async () => {
    calls++;
    return { ok: true, status: 200, async json() {
      throw new SyntaxError('malformed secret: synthetic-secret-never-log');
    } };
  }), (error) => error instanceof VaultGitHubError &&
    error.message === 'github-response-invalid' &&
    !error.message.includes('synthetic-secret'));
  assert.equal(calls, 1);
});

test('B7 transport and CI avoid bypassing OAuth or using real credentials in browser smoke', async () => {
  const source = await readFile(new URL('../lib/oge-vault-github.js', import.meta.url), 'utf8');
  const playwright = await readFile(new URL('../playwright.config.mjs', import.meta.url), 'utf8');
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(source, /method === 'GET' \? 2 : 1/);
  assert.match(source, /github-rate-limited/);
  assert.doesNotMatch(source, /method === 'PATCH' \? 2/);
  assert.match(playwright, /Local-only anonymous smoke tests/);
  assert.match(workflow, /Run local-only anonymous browser tests/);
});
