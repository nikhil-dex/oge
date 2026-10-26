import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('tablet breakpoints cover shared app layouts and core workspace grids', async () => {
  const extra = await readFile(new URL('../public/extra.css', import.meta.url), 'utf8');
  assert.match(extra, /@media\s*\(min-width:\s*601px\)\s*and\s*\(max-width:\s*1100px\)/);
  assert.match(extra, /@media\s*\(min-width:\s*601px\)\s*and\s*\(max-width:\s*850px\)/);
  for (const selector of [
    '.site-navbar', '.oge-topbar', '.home-dashboard-stats', '.home-dashboard-content',
    '.oge-notes-workspace', '.oge-quick-workspace', '.oge-saved-links-layout',
    '.oge-history-workspace', '.oge-extension-content-refined',
    '.oge-revision-ratings-refined', '.oge-settings-card', '.home-news-grid',
  ]) assert.ok(extra.includes(selector), 'Missing tablet responsive rule for ' + selector);
  assert.match(extra, /max-width:\s*calc\(100vw - 40px\)/);
});
