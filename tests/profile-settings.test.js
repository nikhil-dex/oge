import test from 'node:test';
import assert from 'node:assert/strict';
import { PROFILE_AVATARS, normalizeUsername, normalizeProfileDisplayName, isAllowedAvatar, normalizeSocialLink } from '../lib/profile-settings.js';

test('usernames are normalized, bounded and safe for uniqueness', () => {
  assert.equal(normalizeUsername(' Student_42 '), 'student_42');
  assert.equal(normalizeUsername('Nikhil-Dex'), 'nikhil-dex');
  assert.equal(normalizeUsername('nikhil-dex'), 'nikhil-dex');
  assert.equal(normalizeUsername('student_test-42'), 'student_test-42');
  assert.equal(normalizeUsername('abc'), 'abc');
  for (const value of ['ab', '_admin', '-admin', 'a-b-', 'abc_', 'name@example', 'ábc', 'a'.repeat(25), '<script>', 'first.last', 'two words']) {
    assert.equal(normalizeUsername(value), null, value);
  }
});
test('display name rejects control/markup and invalid lengths', () => {
  assert.equal(normalizeProfileDisplayName('  Hello   Student  '), 'Hello Student');
  for (const value of ['', 'x', '<Student>', 'x\ny', 'a'.repeat(61)]) {
    assert.equal(normalizeProfileDisplayName(value), null, value);
  }
});
test('avatar selection is an explicit non-upload allowlist', () => {
  assert.ok(PROFILE_AVATARS.length >= 6);
  assert.equal(isAllowedAvatar('google'), true);
  for (const avatar of PROFILE_AVATARS) assert.equal(isAllowedAvatar(avatar.id), true);
  assert.equal(isAllowedAvatar('https://attacker.example/avatar.svg'), false);
  assert.equal(isAllowedAvatar('data:image/svg+xml,<svg/>'), false);
});

test('MongoDB enforces global uniqueness for normalized usernames', async () => {
  const { readFile } = await import('node:fs/promises');
  const mongodb = await readFile(new URL('../lib/mongodb.js', import.meta.url), 'utf8');
  const actions = await readFile(new URL('../app/profile/actions.js', import.meta.url), 'utf8');
  assert.match(mongodb, /createIndex\(\{ username: 1 \}, \{ unique: true, partialFilterExpression:/);
  assert.match(actions, /normalizeUsername\(formData\.get\('username'\)\)/);
  assert.match(actions, /error\?\.code === 11000/);
  assert.match(actions, /ownerMutationFilter\(ownerId,/);
});

test('optional GitHub and LinkedIn links only accept actual HTTPS profile URLs', () => {
  assert.equal(normalizeSocialLink('github', ''), null);
  assert.equal(normalizeSocialLink('linkedin', '   '), null);
  assert.equal(normalizeSocialLink('github', 'https://github.com/Student-42/'), 'https://github.com/Student-42');
  assert.equal(normalizeSocialLink('linkedin', 'https://linkedin.com/in/student_name-42/'), 'https://www.linkedin.com/in/student_name-42');
  for (const input of ['http://github.com/student', 'https://github.com.evil.test/student',
    'https://github.com/repository/name', 'https://github.com/student?tab=repositories',
    'https://student:password@github.com/student', 'javascript:alert(1)',
    'https://github.com/student#anchor']) {
    assert.equal(normalizeSocialLink('github', input), undefined, input);
  }
  for (const input of ['https://evil-linkedin.com/in/student', 'https://linkedin.com/company/student',
    'http://linkedin.com/in/student', 'https://www.linkedin.com/in/student?x=1']) {
    assert.equal(normalizeSocialLink('linkedin', input), undefined, input);
  }
});
test('portfolio supports public HTTPS domains and blocks local/private URL hosts', () => {
  assert.equal(normalizeSocialLink('portfolio', ''), null);
  assert.equal(normalizeSocialLink('portfolio', 'https://student.dev/projects?tab=latest'), 'https://student.dev/projects?tab=latest');
  for (const input of ['http://student.dev', 'https://localhost:3000', 'https://127.0.0.1/',
    'https://192.168.1.10/', 'https://internal.local', 'https://foo.internal/',
    'https://[::1]/', 'https://example.test', 'https://user:pass@example.com',
    'https://public.dev/#fragment', 'javascript:alert(1)', 'ftp://student.dev/']) {
    assert.equal(normalizeSocialLink('portfolio', input), undefined, input);
  }
  assert.equal(normalizeSocialLink('something-else', ''), undefined);
});
