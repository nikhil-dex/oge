import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownHtml } from '../lib/markdown.js';
import { normalizeSavedLink } from '../lib/saved-links.js';

test('note Markdown escapes executable HTML and does not admit JavaScript links', () => {
  const html = markdownHtml('<script>alert(1)</script> [click](javascript:alert(1))');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script'));
  assert.ok(!html.includes('href="javascript:'));
});

test('note Markdown links use safe target and rel attributes', () => {
  const html = markdownHtml('[reference](https://example.com)');
  assert.match(html, /href="https:\/\/example\.com"/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test('saved links reject script, data, and file URLs', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,hello', 'file:///etc/passwd']) {
    assert.ok(normalizeSavedLink({ title: 'Unsafe', url }).error, url);
  }
  const valid = normalizeSavedLink({ title: 'Safe', url: 'https://example.com' });
  assert.equal(valid.value.url, 'https://example.com/');
});
