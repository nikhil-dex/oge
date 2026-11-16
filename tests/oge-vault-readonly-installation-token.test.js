import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { getVaultNoteClient } from '../lib/oge-vault-notes.js';

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
  .export({ type: 'pkcs8', format: 'pem' }).toString();
const env = { OGE_VAULT_GITHUB_APP_ID: '99',
  OGE_VAULT_GITHUB_PRIVATE_KEY_BASE64: Buffer.from(privateKey).toString('base64') };
const repoId = 1024;
const vault = { status: 'connected', installationId: 98, repoId,
  githubAccountId: '25', githubLogin: 'testowner', repoName: 'ogenotes-vault' };

test('M48 operator GitHub App token requests contents=read; normal writers retain contents=write', async () => {
  const captured = [];
  const fetcher = async (url, options) => {
    captured.push({ url, method: options.method, body: options.body &&
      JSON.parse(options.body) });
    if (url.endsWith('/app/installations/98/access_tokens'))
      return { ok: true, json: async () => ({ token: 'synthetic-read-token',
        repositories: [{ id: repoId }] }) };
    if (url.endsWith('/repos/testowner/ogenotes-vault'))
      return { ok: true, json: async () => ({ id: repoId,
        private: true, owner: { id: 25, login: 'testowner' },
        default_branch: 'main' }) };
    throw Error('Unexpected GitHub path');
  };
  const id = { ownerId: 'owner-' + randomUUID(), sessionVersion: randomUUID() };
  const db = { collection(name) {
    assert.equal(name, 'users');
    return { async findOne() { return { vault }; } };
  } };
  const observer = await getVaultNoteClient(db, id, { env, fetcher, readOnly: true });
  assert.equal(observer.vault.repoId, repoId);
  assert.equal(observer.branch, 'main');
  assert.throws(() => observer.call('/contents/notes/whatever.json', {
    method: 'PUT', body: { content: 'must not write' },
  }), TypeError);
  assert.throws(() => observer.call('/git/refs/heads/main', {
    method: 'PATCH', body: { sha: 'f'.repeat(40) },
  }), TypeError);
  assert.equal(captured[0].body.permissions.contents, 'read');
  assert.equal(captured[0].body.permissions.metadata, 'read');
  await getVaultNoteClient(db, id, { env, fetcher });
  assert.equal(captured[2].body.permissions.contents, 'write');
  assert.deepEqual(captured[2].body.repository_ids, [repoId]);
  await assert.rejects(getVaultNoteClient(db, id, {
    env, fetcher, readOnly: 'false',
  }), TypeError);
});
