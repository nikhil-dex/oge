import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  MAX_MEDIA_FILE_BYTES, MAX_MEDIA_FILES, MAX_MEDIA_FOLDERS,
  VAULT_MEDIA_CHUNK_BYTES, githubVaultFilesEnabled, hasValidMediaSignature,
  normalizeFolderName, normalizeMediaFile,
} from '../lib/oge-vault-media-validation.js';
import {
  VAULT_MEDIA_INDEX_PATH, mediaPartPath, readVaultMediaSnapshot,
  createVaultMediaBlob, applyVaultMediaMutation, mediaList,
  vaultMediaRecord, readVaultMediaBlob,
} from '../lib/oge-vault-media.js';
const read = path => readFile(new URL(path, import.meta.url), 'utf8');

const SHA = /^[0-9a-f]{40}$/;
function fixture() {
  const blobs = new Map();
  const trees = new Map();
  const commits = new Map();
  let next = 1;
  const makeSha = () => (next++).toString(16).padStart(40, '0');
  function newBlob(bytes) {
    const sha = createHash('sha1').update('blob ' + bytes.length + '\0')
      .update(bytes).digest('hex');
    blobs.set(sha, Buffer.from(bytes));
    return sha;
  }
  const treeSha = makeSha(), firstCommit = makeSha();
  trees.set(treeSha, new Map());
  commits.set(firstCommit, { tree: { sha: treeSha }, parents: [] });
  let head = firstCommit;
  const calls = [];
  const client = {
    branch: 'main', vault: { repoId: 123 }, readOnly: false,
    async call(path, { method = 'GET', body } = {}) {
      calls.push({ path, method });
      if (path === '/git/ref/heads/main' && method === 'GET')
        return { object: { sha: head } };
      if (path === '/git/refs/heads/main' && method === 'PATCH') {
        const commit = commits.get(body.sha);
        if (!commit || commit.parents[0].sha !== head || body.force !== false)
          throw new Error('Stale head cannot be force pushed');
        head = body.sha;
        return { ref: 'refs/heads/main', object: { sha: head } };
      }
      const getCommit = /^\/git\/commits\/([0-9a-f]{40})$/.exec(path);
      if (getCommit && method === 'GET') return commits.get(getCommit[1]);
      const getTree = /^\/git\/trees\/([0-9a-f]{40})\?recursive=1$/.exec(path);
      if (getTree && method === 'GET') {
        const entries = trees.get(getTree[1]);
        if (!entries) throw new Error('Missing tree');
        const dirs = new Set();
        for (const p of entries.keys()) {
          const pieces = p.split('/');
          for (let i = 1; i < pieces.length; i++)
            dirs.add(pieces.slice(0, i).join('/'));
        }
        return { truncated: false, tree: [
          ...[...dirs].map(p => ({ path: p, type: 'tree', mode: '040000',
            sha: 'f'.repeat(40) })),
          ...[...entries.entries()].map(([p, sha]) => ({
            path: p, type: 'blob', mode: '100644', sha,
            size: blobs.get(sha).length,
          })),
        ] };
      }
      const getBlob = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(path);
      if (getBlob && method === 'GET') {
        const bytes = blobs.get(getBlob[1]);
        if (!bytes) throw new Error('Missing blob');
        return { sha: getBlob[1], encoding: 'base64', size: bytes.length,
          content: bytes.toString('base64') };
      }
      if (path === '/git/blobs' && method === 'POST') {
        assert.equal(body.encoding, 'base64');
        const bytes = Buffer.from(body.content, 'base64');
        return { sha: newBlob(bytes), size: bytes.length };
      }
      if (path === '/git/trees' && method === 'POST') {
        const base = trees.get(body.base_tree);
        if (!base) throw new Error('Missing base tree');
        const out = new Map(base);
        for (const change of body.tree) {
          if (change.sha === null) out.delete(change.path);
          else out.set(change.path, change.content !== undefined
            ? newBlob(Buffer.from(change.content)) : change.sha);
        }
        const sha = makeSha();
        trees.set(sha, out);
        return { sha };
      }
      if (path === '/git/commits' && method === 'POST') {
        const sha = makeSha();
        commits.set(sha, { tree: { sha: body.tree },
          parents: body.parents.map(parent => ({ sha: parent })) });
        return { sha };
      }
      throw new Error('Unexpected GitHub request: ' + method + ' ' + path);
    },
  };
  return { client, calls, getHead: () => head };
}
test('M129 accepts OgeNotes images, PDF and ZIP formats but not arbitrary executable paths', () => {
  assert.equal(MAX_MEDIA_FILE_BYTES, 20 * 1024 * 1024);
  assert.equal(MAX_MEDIA_FILES, 500);
  assert.equal(MAX_MEDIA_FOLDERS, 100);
  assert.equal(normalizeFolderName('  ML    PDFs ').value, 'ML PDFs');
  assert.match(normalizeFolderName('../private').error, /slashes/);
  for (const [name, type] of [
    ['report.pdf', 'application/pdf'],
    ['archive.zip', 'application/zip'],
    ['diagram.jpg', 'image/jpeg'],
    ['photo.PNG', 'image/png'],
    ['photo.webp', 'image/webp'],
  ]) assert.equal(normalizeMediaFile({ name, type, size: 25 }).error, undefined);
  assert.equal(normalizeMediaFile({
    name: 'script.js', type: 'application/javascript', size: 7,
  }).error, undefined);
  assert.equal(hasValidMediaSignature(Buffer.from('%PDF-1.7'), 'application/pdf'), true);
  assert.equal(hasValidMediaSignature(Buffer.from('PK\x03\x04'), 'application/zip'), true);
});
test('M129 only connected selected GitHub Vault owners can see My Files', () => {
  assert.equal(githubVaultFilesEnabled({ notesStorage: 'github', vault: {
    status: 'connected', repoId: 123,
  } }), true);
  assert.equal(githubVaultFilesEnabled({ notesStorage: 'mongodb', vault: {
    status: 'connected', repoId: 123,
  } }), false);
  assert.equal(githubVaultFilesEnabled({ notesStorage: 'github', vault: {
    status: 'pending', repoId: 123,
  } }), false);
});
test('M129 private GitHub media create/list/folders/rename/move/delete verifies branch writes', async () => {
  const f = fixture();
  const start = await readVaultMediaSnapshot(f.client);
  assert.deepEqual(mediaList(start), { currentFolderId: null, folders: [], files: [] });
  const folder = await applyVaultMediaMutation(f.client, 'create-folder', {
    id: randomUUID(), name: 'Machine Learning',
  });
  assert.equal(folder.name, 'Machine Learning');
  assert.equal((await readVaultMediaSnapshot(f.client)).doc.folders.length, 1);

  const bytes = Buffer.from('%PDF-1.7\nA lesson on supervised learning');
  const chunk = await createVaultMediaBlob(f.client, bytes);
  const id = randomUUID();
  const file = await applyVaultMediaMutation(f.client, 'upload-file', {
    id, name: 'lecture.pdf', type: 'application/pdf', size: bytes.length,
    folderId: folder.id, parts: [chunk],
  });
  assert.equal(file.id, id);
  assert.equal(file.name, 'lecture.pdf');
  assert.equal(file.folderId, folder.id);
  assert.equal(file.parts, undefined);
  let snapshot = await readVaultMediaSnapshot(f.client);
  assert.equal(mediaList(snapshot, folder.id).files[0].name, file.name);
  assert.equal(mediaList(snapshot).files.length, 0);
  assert.equal((await readVaultMediaBlob(f.client, chunk.sha, chunk.size)).toString(), bytes.toString());
  assert.equal(vaultMediaRecord(snapshot, id).parts[0].sha, chunk.sha);

  const repeat = await applyVaultMediaMutation(f.client, 'upload-file', {
    id, name: 'lecture.pdf', type: 'application/pdf', size: bytes.length,
    folderId: folder.id, parts: [chunk],
  });
  assert.equal(repeat.id, id);
  await assert.rejects(() => applyVaultMediaMutation(f.client, 'upload-file', {
    id, name: 'lecture.pdf', type: 'application/pdf', size: bytes.length,
    folderId: folder.id, parts: [{ ...chunk, sha: 'a'.repeat(40) }],
  }), /vault-files-id-conflict/);

  const rename = await applyVaultMediaMutation(f.client, 'rename-file', {
    id, name: 'lecture-renamed.pdf',
  });
  assert.equal(rename.name, 'lecture-renamed.pdf');
  const moved = await applyVaultMediaMutation(f.client, 'move-file', { id, folderId: null });
  assert.equal(moved.folderId, null);
  snapshot = await readVaultMediaSnapshot(f.client);
  assert.equal(mediaList(snapshot).files[0].name, 'lecture-renamed.pdf');
  await applyVaultMediaMutation(f.client, 'delete-file', { id });
  snapshot = await readVaultMediaSnapshot(f.client);
  assert.equal(snapshot.doc.files.length, 0);
  assert.equal(snapshot.map.has(mediaPartPath(id, 0)), false);
  await applyVaultMediaMutation(f.client, 'delete-folder', { id: folder.id });
  assert.equal((await readVaultMediaSnapshot(f.client)).doc.folders.length, 0);
  assert.equal(f.calls.some(c => c.path === '/git/refs/heads/main' &&
    c.method === 'PATCH'), true);
  assert.equal(f.calls.some(c => c.path === '/git/ref/heads/main' &&
    c.method === 'PATCH'), false);
});
test('M129 two-part image upload and folder deletion removes manifest/chunk paths', async () => {
  const f = fixture();
  const folder = await applyVaultMediaMutation(f.client, 'create-folder', {
    name: 'Screenshots',
  });
  const left = Buffer.alloc(VAULT_MEDIA_CHUNK_BYTES, 0);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(left);
  const right = Buffer.from([1, 2, 3, 4, 5]);
  const parts = [await createVaultMediaBlob(f.client, left),
    await createVaultMediaBlob(f.client, right)];
  const id = randomUUID();
  await applyVaultMediaMutation(f.client, 'upload-file', {
    id, name: 'screenshot.png', type: 'image/png',
    size: left.length + right.length, folderId: folder.id, parts,
  });
  const snapshot = await readVaultMediaSnapshot(f.client);
  assert.equal(snapshot.doc.files.length, 1);
  assert.equal(snapshot.map.get(mediaPartPath(id, 1)).sha, parts[1].sha);
  await applyVaultMediaMutation(f.client, 'delete-folder', { id: folder.id });
  const after = await readVaultMediaSnapshot(f.client);
  assert.equal(after.doc.files.length, 0);
  assert.equal(after.map.has(mediaPartPath(id, 0)), false);
  assert.equal(after.map.has(mediaPartPath(id, 1)), false);
});
test('M129 file library UI matches OgeNotes features and routes ONLY to GitHub Vault', async () => {
  const ui = await read('../app/components/media-library.js');
  const page = await read('../app/files/page.js');
  const route = await read('../app/api/vault/media/route.js');
  const navigation = await read('../app/components/site-navbar.js');
  const home = await read('../app/page.js');
  for (const action of ['createFolder', 'renameFolder', 'deleteFolder',
    'uploadFiles', 'openPreview', 'downloadFile', 'renameFile',
    'moveFile', 'shareFile', 'deleteFile'])
    assert.match(ui, new RegExp('async function ' + action));
  assert.match(ui, /media-file-grid/);
  assert.match(ui, /media-folder-grid/);
  assert.match(ui, /media-type-filters/);
  assert.match(ui, /media-pdf-frame/);
  assert.match(ui, /Upload files/);
  assert.match(ui, /application\/zip/);
  assert.match(ui, /\/api\/vault\/media\?action=upload-chunk/);
  assert.doesNotMatch(ui, /\/api\/media|presignedUrl|Vercel Blob|start-upload/);
  assert.match(page, /githubVaultFilesEnabled\(account\)/);
  assert.match(page, /<MediaLibrary \/>/);
  assert.match(route, /ownerMutationFilter\(ownerId, \{ sessionVersion \}\)/);
  assert.match(route, /getVaultNoteClient\(db, \{ ownerId, sessionVersion \}, \{ readOnly \}\)/);
  assert.match(route, /withVaultOwnerDraftWrite/);
  assert.match(route, /Content-Range/);
  assert.match(route, /ReadableStream/);
  assert.doesNotMatch(route, /collection\('mediaFiles'\)|collection\('mediaFolders'\)|@vercel\/blob/);
  assert.match(navigation, /showFiles \? \[\.\.\.links, \{ href: '\/files'/);
  assert.match(home, /filesReady \? \[\{/);
});

test('M130 arbitrary file formats commit to private Git blobs without PDF/image signature requirements', async () => {
  const f = fixture();
  const entries = [
    { name: 'program.js', type: 'application/javascript', bytes: Buffer.from('const greeting = "hi";') },
    { name: 'report.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bytes: Buffer.from('a docx-like binary sample') },
    { name: 'diagram.svg', type: 'image/svg+xml', bytes: Buffer.from('<svg onload="alert(1)"/>') },
    { name: 'audio.mp3', type: 'audio/mpeg', bytes: Buffer.from([1, 2, 3, 4]) },
    { name: 'video.mp4', type: 'video/mp4', bytes: Buffer.from([4, 3, 2, 1]) },
    { name: 'model.safetensors', type: '', bytes: Buffer.from('model data') },
    { name: '.env', type: 'text/plain', bytes: Buffer.from('KEY=value') },
    { name: 'binary', type: '', bytes: Buffer.from([0, 254, 255]) },
  ];
  for (const { name, type, bytes } of entries) {
    const id = randomUUID();
    const part = await createVaultMediaBlob(f.client, bytes);
    const uploaded = await applyVaultMediaMutation(f.client, 'upload-file', {
      id, name, type, size: bytes.length, folderId: null, parts: [part],
    });
    assert.equal(uploaded.name, name);
    assert.equal(uploaded.type, type || 'application/octet-stream');
    const snapshot = await readVaultMediaSnapshot(f.client);
    const saved = vaultMediaRecord(snapshot, id);
    assert.equal(saved.parts.length, 1);
    const downloaded = await readVaultMediaBlob(f.client, saved.parts[0].sha, bytes.length);
    assert.deepEqual(downloaded, bytes);
  }
  assert.equal(mediaList(await readVaultMediaSnapshot(f.client)).files.length, entries.length);
  assert.equal(f.calls.some(c => c.path === '/git/refs/heads/main' && c.method === 'PATCH'), true);
});
