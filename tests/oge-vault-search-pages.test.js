import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadVaultSearchPages } from '../lib/oge-vault-search-pages.js';

function fixture(total = 57) {
  const items = Array.from({ length: total }, (_, i) => ({
    id: 'note-' + i, heading: 'Heading ' + i,
    answer: i === total - 1 ? 'Hidden result near end of Vault' : 'Other note',
  }));
  const calls = [];
  const fetchPage = async (cursor) => {
    calls.push(cursor);
    const index = Number(cursor.slice('page:'.length));
    if (!Number.isInteger(index) || index < 0 || index >= total)
      throw Error('Invalid cursor');
    return {
      notes: items.slice(index, index + 25),
      nextCursor: index + 25 < total ? 'page:' + (index + 25) : null,
      total,
    };
  };
  return { calls, fetchPage };
}

test('M105 whole-Vault on-demand search traverses hidden pages and keeps cursor', async () => {
  const f = fixture();
  const gathered = [];
  const next = await loadVaultSearchPages({
    cursor: 'page:25', fetchPage: f.fetchPage,
    onPage: (notes) => gathered.push(...notes),
  });
  assert.deepEqual(f.calls, ['page:25', 'page:50']);
  assert.equal(next.pages, 2);
  assert.equal(next.loaded, 32);
  assert.equal(next.complete, true);
  assert.equal(next.nextCursor, null);
  assert.equal(gathered.at(-1).answer, 'Hidden result near end of Vault');
});

test('M105 large searches are bounded and resumable across user clicks', async () => {
  const f = fixture(900);
  const loaded = [];
  const first = await loadVaultSearchPages({
    cursor: 'page:0', fetchPage: f.fetchPage,
    onPage: (notes) => loaded.push(...notes),
  });
  assert.equal(first.pages, 12);
  assert.equal(first.loaded, 300);
  assert.equal(first.nextCursor, 'page:300');
  assert.equal(first.complete, false);
  const second = await loadVaultSearchPages({
    cursor: first.nextCursor, fetchPage: f.fetchPage,
    onPage: (notes) => loaded.push(...notes),
  });
  const third = await loadVaultSearchPages({
    cursor: second.nextCursor, fetchPage: f.fetchPage,
    onPage: (notes) => loaded.push(...notes),
  });
  assert.equal(third.complete, true);
  assert.equal(loaded.length, 900);
  assert.equal(new Set(loaded.map((n) => n.id)).size, 900);
});

test('M105 STOP prevents adding a page returned after cancellation', async () => {
  let stopped = false;
  const gathered = [];
  const state = await loadVaultSearchPages({
    cursor: 'page:0',
    fetchPage: async () => {
      stopped = true;
      return { notes: [{ id: 'never-display' }], nextCursor: null, total: 1 };
    },
    shouldStop: () => stopped,
    onPage: (notes) => gathered.push(...notes),
  });
  assert.deepEqual(gathered, []);
  assert.equal(state.stopped, true);
  assert.equal(state.nextCursor, 'page:0');
  assert.equal(state.pages, 0);
});

test('M105 STOP between pages retains the last confirmed cursor and results', async () => {
  const f = fixture();
  let stopped = false;
  const results = [];
  const state = await loadVaultSearchPages({
    cursor: 'page:0', fetchPage: f.fetchPage,
    shouldStop: () => stopped,
    onPage: (page) => { results.push(...page); stopped = true; },
  });
  assert.equal(state.stopped, true);
  assert.equal(state.nextCursor, 'page:25');
  assert.equal(results.length, 25);
});

test('M105 rejects malformed response, repeat cursor, invalid limits; never marks search complete', async () => {
  for (const bad of [
    { notes: [], nextCursor: null, total: 0 },
    { notes: Array.from({ length: 26 }, () => ({})), nextCursor: null, total: 26 },
    { notes: [{}], nextCursor: 'page:0', total: 1 },
    { notes: [{}], nextCursor: '', total: 1 },
    { notes: [{}], nextCursor: 17, total: 1 },
    { notes: [{}], nextCursor: null, total: NaN },
  ]) {
    await assert.rejects(loadVaultSearchPages({
      cursor: 'page:0', fetchPage: async () => bad, onPage: () => {},
    }), /Invalid GitHub Notes page/);
  }
  for (const maxPages of [0, 13, 1.5]) await assert.rejects(
    loadVaultSearchPages({ cursor: 'page:0', fetchPage: () => {}, onPage: () => {}, maxPages }),
    TypeError,
  );
  await assert.rejects(loadVaultSearchPages({ cursor: null, fetchPage: () => {}, onPage: () => {} }), TypeError);
});

test('M105 GitHub Notes UI searches unloaded pages without modifying storage or legacy UI', async () => {
  const ui = await readFile(new URL('../app/notes/page.js', import.meta.url), 'utf8');
  const api = await readFile(new URL('../app/api/vault/notes-main/route.js', import.meta.url), 'utf8');
  assert.match(ui, /import \{ loadVaultSearchPages \} from/);
  assert.match(ui, /notesApi \+ '\?paged=true&limit=25&cursor='/);
  assert.match(ui, /Search all notes/);
  assert.match(ui, /Stop search/);
  assert.match(ui, /No matches in loaded notes yet/);
  assert.match(ui, /All GitHub Notes loaded/);
  assert.match(ui, /searchScanRef\.current\?\.abort\(\)/);
  assert.match(ui, /event\.metaKey \|\| event\.ctrlKey/);
  assert.match(ui, /document\.getElementById\('noteForm'\)\?\.requestSubmit\(\)/);
  assert.match(ui, /Ctrl\+Enter \(Windows\)/);
  assert.match(api, /listVaultNotePage\(ctx\.client, \{ limit, cursor: params\.get\('cursor'\) \}\)/);
  assert.doesNotMatch(api, /collection\(['"]notes['"]\)|insertOne\(|updateOne\(/);
});
