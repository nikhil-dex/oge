import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { scanClientArtifacts } from '../lib/client-artifact-scan.js';

const CANARY = 'synthetic-test-private-credential-987654321';
async function withArtifacts(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oge-artifacts-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('scanner detects a private canary in browser JavaScript, CSS and response HTML', async () => {
  await withArtifacts(async (root) => {
    const staticDir = path.join(root, 'static', 'chunks');
    const appDir = path.join(root, 'server', 'app');
    await mkdir(staticDir, { recursive: true });
    await mkdir(appDir, { recursive: true });
    await writeFile(path.join(staticDir, 'app.js'), 'window.secret=' + CANARY);
    await writeFile(path.join(staticDir, 'app.css'), '/* ' + CANARY + ' */');
    await writeFile(path.join(appDir, 'page.html'), '<span>' + CANARY + '</span>');
    const result = await scanClientArtifacts(root, [CANARY]);
    assert.equal(result.filesScanned, 3);
    assert.deepEqual(result.failures.sort(), ['static/chunks/app.js', 'static/chunks/app.css', 'server/app/page.html'].sort());
  });
});

test('scanner ignores Node server code that legitimately contains server-only secrets', async () => {
  await withArtifacts(async (root) => {
    const server = path.join(root, 'server', 'app');
    const browser = path.join(root, 'static');
    await mkdir(server, { recursive: true });
    await mkdir(browser, { recursive: true });
    await writeFile(path.join(server, 'route.js'), 'const secret=' + CANARY);
    await writeFile(path.join(browser, 'client.js'), 'console.log("public");');
    const result = await scanClientArtifacts(root, [CANARY]);
    assert.equal(result.filesScanned, 1);
    assert.deepEqual(result.failures, []);
  });
});

test('scanner fails closed when artifacts or synthetic canaries are missing', async () => {
  await withArtifacts(async (root) => {
    await assert.rejects(scanClientArtifacts(root, [CANARY]), /No client artifacts/);
    await assert.rejects(scanClientArtifacts(root, ['short']), /synthetic canaries/);
    await assert.rejects(scanClientArtifacts(root, []), /synthetic canaries/);
  });
});

test('CI runs the scanner after the production build and never uses real credentials', async () => {
  const { readFile } = await import('node:fs/promises');
  const ci = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(ci, /node scripts\/verify-client-artifacts\.mjs/);
  assert.ok(ci.indexOf('run: npm run build') < ci.indexOf('node scripts/verify-client-artifacts.mjs'));
});
