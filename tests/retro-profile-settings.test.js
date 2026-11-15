import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('retro design stays scoped to Profile and Settings without changing authentication or controls', async () => {
  const profile = await readFile(new URL('../app/profile/page.js', import.meta.url), 'utf8');
  const settings = await readFile(new URL('../app/settings/page.js', import.meta.url), 'utf8');
  const stylesheet = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');
  for (const source of [profile, settings]) {
    assert.match(source, /oge-retro-workspace/);
    assert.match(source, /oge-retro-workspace-ribbon/);
    assert.match(source, /oge-retro-workspace-stamp/);
    assert.match(source, /SiteNavbar/);
  }
  assert.match(profile, /action=\{saveProfileSettings\}/);
  assert.match(profile, /action=\{connectGoogleAccount\}/);
  assert.match(profile, /action=\{setLinkedPassword\}/);
  assert.match(profile, /action=\{signOutOfOgeNotes\}/);
  assert.match(settings, /<SettingsClient/);
  assert.match(settings, /action=\{saveNewsInterests\}/);
  assert.match(settings, /href="#appearance"/);
  assert.match(stylesheet, /\.oge-retro-workspace \.oge-settings-card\{/);
  assert.match(stylesheet, /\.oge-retro-workspace \.oge-settings-sidebar/);
  assert.match(stylesheet, /\.oge-retro-workspace \.oge-avatar-option/);
  assert.match(stylesheet, /@media\(max-width:850px\)/);
  assert.match(stylesheet, /@media\(max-width:640px\)/);
  assert.match(stylesheet, /focus-visible/);
});
