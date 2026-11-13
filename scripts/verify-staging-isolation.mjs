#!/usr/bin/env node
// Staging-only integration smoke test. Uses two real, independent test accounts.
// NEVER supply production credentials or production deployment URLs.
import { randomUUID } from 'node:crypto';

const urlText = process.env.OGE_STAGING_URL;
const cookieA = process.env.OGE_STAGING_COOKIE_A;
const cookieB = process.env.OGE_STAGING_COOKIE_B;
const allowedHost = process.env.OGE_STAGING_HOST;

function fail(message) { throw new Error(message); }

if (!urlText || !cookieA || !cookieB || !allowedHost) {
  fail('Set OGE_STAGING_URL, OGE_STAGING_HOST, OGE_STAGING_COOKIE_A and OGE_STAGING_COOKIE_B.');
}
const base = new URL(urlText);
if (!['http:', 'https:'].includes(base.protocol) || base.hostname !== allowedHost ||
    !/(staging|preview|localhost|127\\.0\\.0\\.1)/i.test(base.hostname)) {
  fail('Refusing to run outside an explicitly named staging/preview/localhost host.');
}
if (cookieA === cookieB) fail('Two different authenticated sessions are required.');
const testId = randomUUID();
let subjectSlug = null;

async function api(cookie, path, { method = 'GET', body } = {}) {
  const response = await fetch(new URL(path, base), {
    method,
    redirect: 'manual',
    cache: 'no-store',
    headers: {
      Cookie: cookie,
      Origin: base.origin,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
}
const a = (path, opts) => api(cookieA, path, opts);
const b = (path, opts) => api(cookieB, path, opts);
const expect = (condition, name) => { if (!condition) fail(name); };

try {
  const subjectsA = await a('/api/subjects');
  const subjectsB = await b('/api/subjects');
  expect(subjectsA.status === 200 && subjectsB.status === 200, 'Both sessions must authenticate.');
  const title = 'Phase5 test ' + testId.slice(0, 8);
  const createSubject = await a('/api/subjects', { method: 'POST', body: { name: title } });
  expect(createSubject.status === 201 && createSubject.payload.slug, 'Account A must create a test subject.');
  subjectSlug = createSubject.payload.slug;

  const created = await a('/api/notes', {
    method: 'POST',
    body: { subjectSlug, heading: title, answer: 'Temporary isolated test record' },
  });
  expect(created.status === 201 && created.payload.id, 'Account A must create a note.');
  const noteId = created.payload.id;
  const bNotes = await b('/api/notes');
  expect(bNotes.status === 200 && Array.isArray(bNotes.payload), 'Account B must list its own notes.');
  expect(!bNotes.payload.some((note) => note.id === noteId), 'Account B saw account A note.');

  const foreignEdit = await b('/api/notes', {
    method: 'PUT', body: { id: noteId, heading: 'Unauthorized edit', answer: 'Should never succeed' },
  });
  expect(foreignEdit.status === 404 || foreignEdit.status === 403, 'Account B modified account A note.');

  const foreignDelete = await b('/api/notes?id=' + encodeURIComponent(noteId), { method: 'DELETE' });
  expect(foreignDelete.status === 404 || foreignDelete.status === 403, 'Account B deleted account A note.');

  const aNotes = await a('/api/notes');
  expect(aNotes.status === 200 && aNotes.payload.some((note) => note.id === noteId),
    'Account A test note missing or modified.');
  console.log('PASS: Two-account session and Notes isolation smoke test.');
} finally {
  if (subjectSlug) {
    const cleanup = await a('/api/subjects?slug=' + encodeURIComponent(subjectSlug), { method: 'DELETE' });
    if (cleanup.status !== 200) {
      console.error('Test subject cleanup did not complete; remove the temporary staging subject manually.');
      process.exitCode = 1;
    }
  }
}
