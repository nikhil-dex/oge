import test from 'node:test';
import assert from 'node:assert/strict';
import { PROFILE_AVATARS, normalizeUsername, normalizeProfileDisplayName, isAllowedAvatar } from '../lib/profile-settings.js';

test('usernames are normalized, bounded and safe for uniqueness', () => {
  assert.equal(normalizeUsername(' Student_42 '), 'student_42');
  for (const value of ['ab', '_admin', 'a-b', 'name@example', 'ábc', 'a'.repeat(25), '<script>']) {
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
