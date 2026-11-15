import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('collapsed launcher supports direct dragging without triggering a click', async () => {
  const script = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
  assert.match(script, /launcher\.addEventListener\('pointerdown'/);
  assert.match(script, /launcher\.setPointerCapture\(event\.pointerId\)/);
  assert.match(script, /launcher\.addEventListener\('pointermove'/);
  assert.match(script, /Math\.hypot\(dx, dy\) < 5/);
  assert.match(script, /ignoreLauncherClick = true/);
  assert.match(script, /if \(ignoreLauncherClick\)/);
  assert.match(script, /placeLauncher\(launcherDrag\.left \+ dx, launcherDrag\.top \+ dy\)/);
  assert.match(script, /launcher\.addEventListener\('click'/);
});

test('floating panel can grow horizontally and vertically with viewport boundaries', async () => {
  const script = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
  assert.match(script, /resize:both/);
  assert.match(script, /Resize widget width and height/);
  assert.match(script, /resize-corner-left/);
  assert.match(script, /panel\.style\.width = width \+ 'px'/);
  assert.match(script, /panel\.style\.height = height \+ 'px'/);
  assert.match(script, /window\.innerWidth - resizeDrag\.left - GAP/);
  assert.match(script, /window\.innerHeight - resizeDrag\.top - GAP/);
  assert.match(script, /window\.addEventListener\('resize'/);
  assert.match(script, /function positionPanel\(\)/);
});

test('idle state fades and user activity restores visibility without hiding tools', async () => {
  const script = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
  assert.match(script, /const IDLE_DELAY_MS = 12000/);
  assert.match(script, /host\.style\.opacity = '1'/);
  assert.match(script, /clearTimeout\(idleTimer\)/);
  assert.match(script, /setTimeout\(\(\) =>/);
  assert.match(script, /panel\.classList\.contains\('hidden'\) \? '\.38' : '\.78'/);
  assert.match(script, /window\.addEventListener\(name, wake, \{ passive: true \}\)/);
  assert.match(script, /document\.addEventListener\('visibilitychange'/);
  assert.match(script, /shadow\.addEventListener\('pointerdown', wake\)/);
  assert.match(script, /prefers-reduced-motion:reduce/);
});

test('compact polish preserves note subject and other floating actions', async () => {
  const script = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
  for (const part of ['id="oge-note-subject"', "send('GET_SUBJECTS')", "send('CREATE_QUICK_NOTE'",
    "send('SAVE_CURRENT_TAB'", "send('GET_PROFILE_LINKS'", "send('VISIT_PROFILE_LINK'",
    "['keydown', 'keyup', 'keypress']"]) {
    assert.ok(script.includes(part), part);
  }
  assert.doesNotMatch(script, /chrome\.storage\.local/);
  assert.doesNotMatch(script, /Authorization: 'Bearer '/);
});
