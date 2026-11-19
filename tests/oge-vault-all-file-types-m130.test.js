import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  MAX_MEDIA_FILE_BYTES, normalizeMediaFile,
  canPreviewMediaFile, needsMediaSignatureCheck,
} from '../lib/oge-vault-media-validation.js';
const read = relative => readFile(new URL(relative, import.meta.url), 'utf8');

test('M130 any file type can be saved, including unknown and extensionless files', () => {
  for (const [name, type] of [
    ['source.py', 'text/x-python'], ['program.js', 'application/javascript'],
    ['movie.mp4', 'video/mp4'], ['song.mp3', 'audio/mpeg'],
    ['letter.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['presentation.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ['sheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['drawing.svg', 'image/svg+xml'], ['design.psd', 'image/vnd.adobe.photoshop'],
    ['backup.7z', 'application/x-7z-compressed'],
    ['source.tar.gz', 'application/gzip'],
    ['data.csv', 'text/csv'], ['index.html', 'text/html'],
    ['model.pkl', 'application/octet-stream'],
  ]) {
    const result = normalizeMediaFile({ name, type, size: 1024 });
    assert.equal(result.error, undefined, name + ' rejected');
    assert.equal(result.value.type, type);
  }
  assert.equal(normalizeMediaFile({ name: 'unknown-format', type: '', size: 12 })
    .value.type, 'application/octet-stream');
  assert.equal(normalizeMediaFile({ name: 'model.bin', size: 12 })
    .value.type, 'application/octet-stream');
  assert.equal(normalizeMediaFile({ name: 'notes.txt', type: 'text/plain', size: 12 })
    .value.extension, '.txt');
  assert.equal(MAX_MEDIA_FILE_BYTES, 20 * 1024 * 1024);
  assert.match(normalizeMediaFile({ name: 'too-large.mp4', type: 'video/mp4',
    size: MAX_MEDIA_FILE_BYTES + 1 }).error, /20 MB/);
  assert.match(normalizeMediaFile({ name: '../escape.txt', type: 'text/plain',
    size: 1 }).error, /path separators/);
  assert.match(normalizeMediaFile({ name: 'unsafe.html', type: 'text/html\r\nx-malicious: yes',
    size: 1 }).error, /Invalid file content type/);
});

test('M130 only PDF and raster images are inlined; SVG, HTML and JS download as attachments', async () => {
  for (const file of [
    { name: 'report.pdf', type: 'application/pdf' },
    { name: 'image.jpg', type: 'image/jpeg' },
    { name: 'image.png', type: 'image/png' },
    { name: 'image.webp', type: 'image/webp' },
  ]) {
    assert.equal(canPreviewMediaFile(file), true, file.name);
    assert.equal(needsMediaSignatureCheck(file), true);
  }
  for (const file of [
    { name: 'danger.svg', type: 'image/svg+xml' },
    { name: 'index.html', type: 'text/html' },
    { name: 'module.js', type: 'application/javascript' },
    { name: 'unknown', type: 'application/octet-stream' },
    { name: 'fake.pdf', type: 'text/plain' },
    { name: 'raster.txt', type: 'image/png' },
    { name: 'backup.zip', type: 'application/zip' },
  ]) {
    assert.equal(canPreviewMediaFile(file), false, file.name);
  }
  assert.equal(needsMediaSignatureCheck({
    name: 'backup.zip', type: 'application/zip',
  }), true);

  const route = await read('../app/api/vault/media/route.js');
  assert.match(route, /const previewable = canPreviewMediaFile\(file\)/);
  assert.match(route, /previewable \? file\.type : 'application\/octet-stream'/);
  assert.match(route, /download \|\| !previewable/);
  assert.match(route, /'X-Content-Type-Options': 'nosniff'/);
  assert.match(route, /Content-Disposition/);
});

test('M130 My Files allows every file picker format and provides Other downloads', async () => {
  const ui = await read('../app/components/media-library.js');
  const library = await read('../lib/oge-vault-media.js');
  assert.match(ui, /type="file" multiple onChange=\{uploadFiles\}/);
  assert.doesNotMatch(ui, /accept="\.[^"]+"/);
  assert.match(ui, /\['other','Other'\]/);
  assert.match(ui, /file\.type \|\| 'application\/octet-stream'/);
  assert.match(ui, /if \(!canPreviewMediaFile\(file\)\)/);
  assert.match(ui, /await downloadFile\(file\)/);
  assert.match(ui, /canPreviewMediaFile\(file\) && <button/);
  assert.match(library, /needsMediaSignatureCheck\(norm\.value\)/);
  assert.match(library, /createVaultMediaBlob/);
});
