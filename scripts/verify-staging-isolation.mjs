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
const createdResources = [];

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
  const createRevision = await a('/api/notes', {
    method: 'PUT',
    body: { id: noteId, heading: title, answer: 'Second private revision of temporary record' },
  });
  expect(createRevision.status === 200, 'A could not create a temporary history snapshot.');

  const foreignRevision = await b('/api/revision', {
    method: 'POST', body: { id: noteId, rating: 'good' },
  });
  expect([403, 404].includes(foreignRevision.status), 'B modified A revision schedule.');

  const foreignHistory = await b('/api/revision-history');
  expect(foreignHistory.status === 200 && Array.isArray(foreignHistory.payload) &&
    !foreignHistory.payload.some((entry) => entry.noteId === noteId),
    'B can read A revision history.');

  const foreignRestore = await b('/api/revision-history', {
    method: 'POST', body: { noteId, revisionIndex: 0 },
  });
  expect([403, 404].includes(foreignRestore.status), 'B restored A revision history.');

  const backupA = await a('/api/backup');
  const backupB = await b('/api/backup');
  expect(backupA.status === 200 && backupB.status === 200,
    'Two-account backup export failed.');
  expect(Array.isArray(backupA.payload.notes) &&
    backupA.payload.notes.some((item) => item.id === noteId),
    'A backup does not contain A test note.');
  expect(Array.isArray(backupB.payload.notes) &&
    !backupB.payload.notes.some((item) => item.id === noteId),
    'B backup leaked A private note.');

  // Each resource is created by A, checked against B's reads and mutations,
  // then removed by A in finally. Use disposable staging accounts only.
  const resources = [
    { path: '/api/quick-notes', label: 'Quick Notes', value: { content: title + ' private quick note' } },
    { path: '/api/personal-quick-notes', label: 'AirNotes', value: { content: title + ' private AirNote' } },
    { path: '/api/saved-links', label: 'Saved Links', value: { title, url: 'https://example.com/?oge-staging=' + testId } },
  ];
  for (const resource of resources) {
    const made = await a(resource.path, { method: 'POST', body: resource.value });
    expect(made.status === 201 && made.payload.id, resource.label + ': A cannot create test record.');
    const id = String(made.payload.id);
    createdResources.push({ path: resource.path, id, label: resource.label });

    const foreignList = await b(resource.path);
    expect(foreignList.status === 200 && Array.isArray(foreignList.payload),
      resource.label + ': B cannot read its records.');
    expect(!foreignList.payload.some((entry) => String(entry.id) === id),
      resource.label + ': B can read A private record.');

    const foreignUpdate = await b(resource.path, {
      method: 'PUT',
      body: { id, ...resource.value, ...(resource.value.content ? { content: title + ' unauthorized update' } : { title: title + ' unauthorized update' }) },
    });
    expect([403, 404].includes(foreignUpdate.status),
      resource.label + ': B was able to update A private record.');

    const foreignRemove = await b(resource.path + '?id=' + encodeURIComponent(id), { method: 'DELETE' });
    expect([403, 404].includes(foreignRemove.status),
      resource.label + ': B was able to delete A private record.');

    const ownerList = await a(resource.path);
    expect(ownerList.status === 200 && Array.isArray(ownerList.payload) &&
      ownerList.payload.some((entry) => String(entry.id) === id),
      resource.label + ': A private test record missing after B attempts.');
  }

  // Also verify that B cannot find A's newly created subject.
  const foreignSubjects = await b('/api/subjects');
  expect(foreignSubjects.status === 200 && Array.isArray(foreignSubjects.payload) &&
    !foreignSubjects.payload.some((entry) => entry.slug === subjectSlug),
    'Account B can view account A private subject.');

  console.log('PASS: Two-account Notes, Subjects, Quick Notes, AirNotes, Saved Links, Revision, History and Backup export isolation smoke test.');
} finally {
  // Remove created records even when an isolation assertion fails.
  for (const resource of createdResources.reverse()) {
    try {
      const cleanup = await a(resource.path + '?id=' + encodeURIComponent(resource.id), { method: 'DELETE' });
      if (cleanup.status !== 200) {
        console.error(resource.label + ' test record cleanup failed; remove it manually from staging.');
        process.exitCode = 1;
      }
    } catch {
      console.error(resource.label + ' cleanup request failed; remove it manually from staging.');
      process.exitCode = 1;
    }
  }
  if (subjectSlug) {
    const cleanup = await a('/api/subjects?slug=' + encodeURIComponent(subjectSlug), { method: 'DELETE' });
    if (cleanup.status !== 200) {
      console.error('Test subject cleanup did not complete; remove the temporary staging subject manually.');
      process.exitCode = 1;
    }
  }
}
