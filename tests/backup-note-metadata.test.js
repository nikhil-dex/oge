import test from 'node:test';
import assert from 'node:assert/strict';
import { exportNoteMetadata, importNoteMetadata } from '../lib/backup-note-metadata.js';

test('exports revisions and review metadata without credentials or ownership fields', () => {
  const note = {
    ownerId: 'private-owner',
    geminiApiKey: { ciphertext: 'secret' },
    revisions: [{ heading: 'Earlier', answer: 'Historical text', savedAt: '2026-01-01T00:00:00.000Z' }],
    reviewCount: 4,
    lastReviewRating: 'good',
    lastReviewedAt: '2026-01-02T00:00:00.000Z',
    reviewDueAt: '2026-01-09T00:00:00.000Z',
  };
  const exported = exportNoteMetadata(note);
  assert.equal(exported.revisions.length, 1);
  assert.equal(exported.reviewCount, 4);
  assert.equal(exported.lastReviewRating, 'good');
  assert.equal(exported.ownerId, undefined);
  assert.equal(exported.geminiApiKey, undefined);
  const imported = importNoteMetadata(exported);
  assert.equal(imported.revisions[0].answer, 'Historical text');
  assert.ok(imported.reviewDueAt instanceof Date);
});

test('old backup notes without history import with safe defaults', () => {
  assert.deepEqual(importNoteMetadata({ heading: 'Old', answer: 'Backup' }), {
    revisions: [], reviewCount: 0,
  });
});

test('malformed and oversized revision metadata is rejected', () => {
  assert.equal(importNoteMetadata({ revisions: Array.from({ length: 21 }, () => ({ heading: 'a', answer: 'b' })) }), null);
  assert.equal(importNoteMetadata({ revisions: [{ heading: 'ok', answer: '<script>', savedAt: 'not-a-date' }] }), null);
  assert.equal(importNoteMetadata({ revisions: [{ heading: 'a'.repeat(161), answer: 'b' }] }), null);
  assert.equal(importNoteMetadata({ reviewCount: -1 }), null);
  assert.equal(importNoteMetadata({ reviewCount: '2' }), null);
  assert.equal(importNoteMetadata({ lastReviewRating: 'root' }), null);
  assert.equal(importNoteMetadata({ reviewDueAt: 'invalid' }), null);
});

test('backup route includes validated revisions in export and import', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../app/api/backup/route.js', import.meta.url), 'utf8');
  assert.match(source, /\.\.\.exportNoteMetadata\(item\)/);
  assert.match(source, /\.\.\.importNoteMetadata\(source\)/);
  assert.match(source, /!importNoteMetadata\(item\)/);
});
