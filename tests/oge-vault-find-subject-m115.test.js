import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadVaultSearchPages } from '../lib/oge-vault-search-pages.js';

const SUBJECT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SUBJECT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function fakePageReader(notes, { pageSize = 25 } = {}) {
  const calls = [];
  const fetchPage = async (cursor) => {
    calls.push(cursor);
    const offset = Number(cursor.slice(2));
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= notes.length)
      throw new Error('Unexpected GitHub page cursor');
    const page = notes.slice(offset, offset + pageSize);
    const nextOffset = offset + page.length;
    return { notes: page,
      nextCursor: nextOffset < notes.length ? 'p:' + nextOffset : null,
      total: notes.length };
  };
  return { calls, fetchPage };
}

function notesWithSubjectAt({ total, matchingAt = -1 } = {}) {
  return Array.from({ length: total }, (_, index) => ({
    id: 'note-' + index,
    subjectSlug: index === matchingAt ? SUBJECT_B : SUBJECT_A,
    heading: 'Note ' + index, answer: 'GitHub content',
  }));
}

test('M115 empty subject is discoverable beyond first GitHub page without typing search text', async () => {
  const all = notesWithSubjectAt({ total: 151, matchingAt: 82 });
  const reader = fakePageReader(all);
  const loaded = all.slice(0, 20);
  let found = false;
  let cursor = 'p:20';
  const result = await loadVaultSearchPages({
    cursor, maxPages: 12,
    fetchPage: reader.fetchPage,
    shouldStop: () => found,
    onPage: (incoming, page) => {
      loaded.push(...incoming);
      found = incoming.some((note) => note.subjectSlug === SUBJECT_B);
      cursor = page.nextCursor;
    },
  });
  assert.equal(found, true);
  assert.equal(loaded.some((note) => note.subjectSlug === SUBJECT_B), true);
  assert.equal(result.pages, 3);
  assert.equal(result.stopped, true);
  assert.deepEqual(reader.calls, ['p:20', 'p:45', 'p:70']);
  assert.ok(result.nextCursor, 'later notes stay available through Load more');
  assert.equal(loaded.filter((note) => note.subjectSlug === SUBJECT_B).length, 1);
});

test('M115 no older subject notes: scan finishes without inventing a first Note', async () => {
  const all = notesWithSubjectAt({ total: 49 });
  const reader = fakePageReader(all);
  let found = false;
  let examined = 0;
  const result = await loadVaultSearchPages({
    cursor: 'p:20',
    fetchPage: reader.fetchPage,
    shouldStop: () => found,
    onPage: (incoming) => {
      examined += incoming.length;
      found = incoming.some((note) => note.subjectSlug === SUBJECT_B);
    },
  });
  assert.equal(examined, 29);
  assert.equal(found, false);
  assert.equal(result.complete, true);
  assert.equal(result.nextCursor, null);
});

test('M115 search for a subject remains bounded to twelve pages per click', async () => {
  const all = notesWithSubjectAt({ total: 720, matchingAt: 585 });
  const reader = fakePageReader(all);
  let found = false;
  const first = await loadVaultSearchPages({
    cursor: 'p:20', fetchPage: reader.fetchPage,
    shouldStop: () => found,
    onPage: (incoming) => {
      found = incoming.some((note) => note.subjectSlug === SUBJECT_B);
    },
  });
  assert.equal(first.pages, 12);
  assert.equal(first.complete, false);
  assert.equal(found, false);
  const second = await loadVaultSearchPages({
    cursor: first.nextCursor, fetchPage: reader.fetchPage,
    shouldStop: () => found,
    onPage: (incoming) => {
      found = incoming.some((note) => note.subjectSlug === SUBJECT_B);
    },
  });
  assert.equal(found, true);
  assert.equal(second.stopped, true);
  assert.equal(second.pages, 11);
});

test('M115 UI offers a subject-specific search only when it really has unloaded GitHub pages', async () => {
  const ui = await readFile(new URL('../app/notes/page.js', import.meta.url), 'utf8');
  assert.match(ui, /async function scanRemainingVaultNotes\(\{ subjectOnly = false \} = \{\}\)/);
  assert.match(ui, /const targetSubject = subjectOnly \? activeSubject : null/);
  assert.match(ui, /foundSubjectNote = incoming\.some\(\(note\) => note\.subjectSlug === targetSubject\)/);
  assert.match(ui, /shouldStop: \(\) => controller\.signal\.aborted \|\| foundSubjectNote/);
  assert.match(ui, /scanRemainingVaultNotes\(\{ subjectOnly: true \}\)/);
  assert.match(ui, /No Notes from this subject loaded yet/);
  assert.match(ui, /Find older Notes in this subject/);
  assert.match(ui, /All GitHub Notes checked\. There are no older Notes for this subject/);
  assert.match(ui, /!globalSearch && !favoritesOnly && !selectedTag/);
  assert.match(ui, /nextNotesCursor && !query\.trim\(\)/);
  assert.match(ui, /Add a note/);
});
