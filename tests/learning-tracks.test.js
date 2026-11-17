import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeLearningTrack, parseYouTubePlaylist, publicLearningTrack } from '../lib/learning-tracks.js';

test('parse only real HTTPS YouTube playlist links, never URLs from impersonating hosts', () => {
  const id = 'PL0123456789_example_playlist_id';
  assert.deepEqual(parseYouTubePlaylist('https://www.youtube.com/watch?v=abc&list=' + id),
    { playlistId: id, playlistUrl: 'https://www.youtube.com/playlist?list=' + id });
  assert.equal(parseYouTubePlaylist('https://youtube.com/playlist?list=' + id)?.playlistId, id);
  for (const raw of [
    'http://youtube.com/playlist?list=' + id,
    'https://youtube.com.evil.org/playlist?list=' + id,
    'https://youtube.com@evil.org/playlist?list=' + id,
    'https://youtube.com/playlist?list=' + id + '&list=' + id,
    'https://youtube.com/redirect?list=' + id,
    'https://youtube.com/playlist?list=bad!',
    'file:///playlist?list=' + id,
    'https://example.org/playlist?list=' + id,
  ]) assert.equal(parseYouTubePlaylist(raw), null, raw);
});
test('validate goal and total without scraping user private videos', () => {
  const input = { url: 'https://youtube.com/playlist?list=PL0123456789example', title: '  ML  Playlist  ', videosPerDay: 2, totalVideos: null };
  const normalized = normalizeLearningTrack(input);
  assert.equal(normalized.value.title, 'ML Playlist');
  assert.equal(normalized.value.videosPerDay, 2);
  assert.equal(normalized.value.totalVideos, null);
  for (const change of [{ title: '' }, { videosPerDay: 0 }, { videosPerDay: 21 }, { videosPerDay: 2.5 },
    { totalVideos: 0 }, { totalVideos: 10001 }, { totalVideos: '42' }])
    assert.ok(normalizeLearningTrack({ ...input, ...change }).error);
  const track = publicLearningTrack({ _id: 'test', ownerId: 'private-owner', ...normalized.value,
    completedVideos: 0, createdAt: new Date(0), updatedAt: new Date(0) });
  assert.equal('ownerId' in track, false);
  assert.equal('noteContent' in track, false);
});
test('M97 gates, owner fences, extension tab authority, and no legacy notes storage are explicit', async () => {
  const read = async (p) => readFile(new URL(p, import.meta.url), 'utf8');
  const page = await read('../app/api/learning-tracks/route.js');
  const extension = await read('../app/api/extension/learning-track/route.js');
  const worker = await read('../extension/service-worker.js');
  const db = await read('../lib/mongodb.js');
  const deleteAccount = await read('../lib/account-deletion-transaction.js');
  assert.match(page, /OGE_LEARNING_TRACKS_PREVIEW/);
  assert.match(extension, /OGE_LEARNING_TRACKS_PREVIEW/);
  assert.match(page, /withActiveOwnerMutation/);
  assert.match(extension, /extensionTokenHash: tokenHash/);
  assert.match(worker, /sender\.tab\.url/);
  assert.match(worker, /CREATE_LEARNING_TRACK/);
  assert.match(db, /learningTracks.*createIndex\(\{ ownerId: 1, playlistId: 1 \}/);
  const limiter = await read('../lib/rate-limit.js');
  assert.match(limiter, /'learning-tracks'/);
  assert.match(deleteAccount, /'learningTracks'/);
  assert.doesNotMatch(page + extension, /collection\(['"]notes['"]\)/);
});
