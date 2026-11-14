#!/usr/bin/env node
/**
 * DESTRUCTIVE staging-only account-deletion verification.
 *
 * Run only with a disposable Google test identity and isolated database.
 * This permanently removes the test account's workspace when the API is enabled.
 * Never commit cookies or use your own real account.
 */
import { randomUUID } from 'node:crypto';

const config = {
  url: process.env.OGE_STAGING_URL,
  host: process.env.OGE_STAGING_HOST,
  firstCookie: process.env.OGE_STAGING_COOKIE_A,
  secondCookie: process.env.OGE_STAGING_COOKIE_B,
  confirmation: process.env.OGE_STAGING_DELETION_CONFIRM,
};
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
assert(config.url && config.host && config.firstCookie && config.secondCookie,
  'Set OGE_STAGING_URL, OGE_STAGING_HOST and two distinct session cookies for the SAME disposable Google test account.');
assert(config.confirmation === 'DELETE DISPOSABLE STAGING ACCOUNT',
  'Refusing destructive test without OGE_STAGING_DELETION_CONFIRM=DELETE DISPOSABLE STAGING ACCOUNT.');
assert(config.firstCookie !== config.secondCookie,
  'Use distinct browser sessions for the same disposable test identity.');
const base = new URL(config.url);
assert(base.hostname === config.host &&
  /(?:^|[.-])(staging|preview)(?:[.-]|$)|^(?:localhost|127\.0\.0\.1)$/.test(base.hostname),
  'Refusing to delete data outside a staging/preview/localhost host.');
assert(base.protocol === 'https:' || (base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname)),
  'HTTPS is required except on localhost.');
assert(base.username === '' && base.password === '' && base.pathname === '/' &&
  !base.search && !base.hash,
  'Staging URL must be a plain origin without credentials, paths, queries or fragments.');

async function api(cookie, path, method = 'GET', data) {
  const response = await fetch(new URL(path, base), {
    method, redirect: 'manual', cache: 'no-store',
    headers: {
      Cookie: cookie,
      Origin: base.origin,
      ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, payload };
}

const first = (path, method, data) => api(config.firstCookie, path, method, data);
const second = (path, method, data) => api(config.secondCookie, path, method, data);
const marker = 'Disposable deletion check ' + randomUUID().slice(0, 8);

// Never delete an account containing existing user content.
const backup = await first('/api/backup');
assert(backup.status === 200 && backup.payload?.format === 'oge-notes-backup',
  'The first test account must be authenticated and able to export.');
for (const name of ['notes', 'savedLinks', 'quickNotes', 'personalQuickNotes']) {
  assert(Array.isArray(backup.payload[name]) && backup.payload[name].length === 0,
    'Refusing deletion: test account already contains ' + name + '.');
}
assert(Array.isArray(backup.payload.subjects) && backup.payload.subjects.length <= 1,
  'Refusing deletion: test account has multiple existing subjects.');
assert(!backup.payload.subjects.some((subject) => !['general', 'General', 'Getting Started'].includes(subject.name)),
  'Refusing deletion: test account has a non-default subject.');

// Even empty workspaces may have valuable external credentials or active tokens.
const extension = await first('/api/extension-token');
assert(extension.status === 200 && extension.payload?.connected === false,
  'Refusing deletion: extension token is configured or cannot be verified.');
const gemini = await first('/api/gemini-key');
assert(gemini.status === 200 && gemini.payload?.configured === false,
  'Refusing deletion: Gemini credential is configured or cannot be verified.');

const made = await first('/api/subjects', 'POST', { name: marker });
assert(made.status === 201 && typeof made.payload?.slug === 'string',
  'Cannot create temporary marker; no deletion attempted.');
const slug = made.payload.slug;
const otherSubjects = await second('/api/subjects');
assert(otherSubjects.status === 200 && Array.isArray(otherSubjects.payload) &&
  otherSubjects.payload.some((subject) => subject.slug === slug),
  'Second cookie is not a valid session for the SAME disposable identity; deletion refused.');

const deleted = await first('/api/account', 'DELETE', { confirmation: 'DELETE MY ACCOUNT' });
assert(deleted.status === 200 && deleted.payload?.deleted === true,
  'Deletion did not succeed; inspect staging. Do not retry until any temporary marker is removed.');

for (const [label, cookie] of [['first', config.firstCookie], ['second', config.secondCookie]]) {
  const result = await api(cookie, '/api/subjects');
  assert(result.status === 401 || (result.status >= 300 && result.status < 400),
    'Account ' + label + ' session was still accepted after deletion (status ' + result.status + ').');
}
console.log('PASS: Disposable staging account deleted and both independent sessions invalidated.');
console.log('Manual follow-ups: confirm stored records and extension token absent, and re-login receives a fresh account session version.');
