import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { vaultCaptureFields, vaultCaptureRecoveryText } from '../lib/oge-vault-quick-capture.js';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('M109 one-line capture is restored verbatim from an equivalent browser copy', () => {
  const subject = randomUUID();
  const original = 'Buy groceries';
  const stored = vaultCaptureFields(original, subject);
  const recovered = vaultCaptureRecoveryText(stored, original);
  assert.equal(recovered.matchesBrowserCopy, true);
  assert.equal(recovered.text, original);
  assert.equal(recovered.serverText, 'Buy groceries\nBuy groceries');
});

test('M109 recover original two-line duplicate text, formatting and explicit title/body', () => {
  const subject = randomUUID();
  for (const original of [
    'Same\nSame', 'Heading\nBody goes here', '  Title  \r\n  details  ',
    '\nBuy groceries', 'Buy groceries\n',
  ]) {
    const draft = vaultCaptureFields(original, subject);
    const recovered = vaultCaptureRecoveryText(draft, original);
    assert.equal(recovered.matchesBrowserCopy, true);
    assert.equal(recovered.text, original);
  }
});

test('M109 divergent/invalid browser copy never silently replaces a saved draft', () => {
  const subject = randomUUID();
  const draft = vaultCaptureFields('Meeting notes\nConfirmed details', subject);
  const canonical = 'Meeting notes\nConfirmed details';
  for (const local of [null, '', 'Meeting notes\nDifferent details', 'Unsaved newer body']) {
    const result = vaultCaptureRecoveryText(draft, local);
    assert.equal(result.matchesBrowserCopy, false);
    assert.equal(result.text, canonical);
  }
  assert.throws(() => vaultCaptureRecoveryText({ heading: 'x', answer: 'y', subjectId: 'bad' }, 'x'), TypeError);
});

function simulateFloatingSave({
  initial = 'Buy groceries', subject = randomUUID(), vaultReady = true, send,
} = {}) {
  let handler;
  const statuses = [];
  const note = { value: initial };
  const subjectSelect = { value: subject };
  const noteSave = {
    disabled: false,
    addEventListener(type, action) {
      assert.equal(type, 'click');
      handler = action;
    },
  };
  const ctx = {
    noteSave, note, subjectSelect, vaultReady,
    pendingVaultCapture: null,
    createCaptureId: () => randomUUID(),
    setStatus: (...args) => statuses.push(args),
    send,
  };
  return { ctx, statuses, note, subjectSelect, noteSave,
    async mount() {
      const source = await read('../extension/content.js');
      const start = source.indexOf("  noteSave.addEventListener('click', async () => {");
      const end = source.indexOf("  const urlSave = ", start);
      assert.ok(start > 0 && end > start, 'Save handler must be discoverable in the actual extension');
      vm.runInNewContext(source.slice(start, end), ctx, { timeout: 2000 });
      return () => handler();
    },
  };
}

test('M109 extension does not erase newer text typed while GitHub Save is pending', async () => {
  let finish;
  const submitted = [];
  const ui = simulateFloatingSave({
    send: async (action, payload) => {
      submitted.push({ action, payload });
      return new Promise((resolve) => { finish = resolve; });
    },
  });
  const save = await ui.mount();
  const running = save();
  assert.equal(ui.noteSave.disabled, true);
  ui.note.value = 'Buy groceries and eggs';
  finish({ destination: 'vault', confirmed: true, title: 'Buy groceries', subject: 'General' });
  await running;
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].action, 'CREATE_VAULT_NOTE');
  assert.equal(submitted[0].payload.content, 'Buy groceries');
  assert.equal(ui.note.value, 'Buy groceries and eggs');
  assert.match(ui.statuses.at(-1)[0], /Newer edits are still in your editor/);
  assert.equal(ui.noteSave.disabled, false);
});

test('M109 extension clears only exactly submitted text on a confirmed Save', async () => {
  const ui = simulateFloatingSave({
    send: async () => ({ destination: 'vault', confirmed: true, title: 'Buy groceries', subject: 'General' }),
  });
  const save = await ui.mount();
  await save();
  assert.equal(ui.note.value, '');
  assert.match(ui.statuses.at(-1)[0], /Saved .* to GitHub Vault/);
  assert.doesNotMatch(ui.statuses.at(-1)[0], /Newer edits/);
});

test('M109 uncertain extension response retains exact text and UUID for an unchanged retry', async () => {
  let attempts = 0;
  const captureIds = [];
  const ui = simulateFloatingSave({
    send: async (action, payload) => {
      captureIds.push(payload.captureId);
      attempts += 1;
      if (attempts === 1) throw new Error('Connection interrupted');
      return { destination: 'vault', confirmed: true, title: 'Buy groceries', subject: 'General' };
    },
  });
  const save = await ui.mount();
  await save();
  assert.equal(ui.note.value, 'Buy groceries');
  assert.match(ui.statuses.at(-1)[0], /Connection interrupted/);
  await save();
  assert.equal(ui.note.value, '');
  assert.equal(captureIds[0], captureIds[1]);
});

test('M109 legacy extension Save uses the captured text, not later edits', async () => {
  let finish;
  const ui = simulateFloatingSave({
    vaultReady: false,
    send: async () => new Promise((resolve) => { finish = resolve; }),
  });
  const save = await ui.mount();
  const running = save();
  ui.note.value = 'A newer thought';
  finish({ destination: 'quick-notes', title: 'Buy groceries' });
  await running;
  assert.equal(ui.note.value, 'A newer thought');
  assert.match(ui.statuses.at(-1)[0], /Newer edits are still in your editor/);
});

test('M109 Quick Capture UI uses equivalence-aware recovery and avoids rewriting an accepted draft', async () => {
  const ui = await read('../app/vault/capture/vault-quick-capture-client.js');
  assert.match(ui, /vaultCaptureRecoveryText\(candidate\.draft, local\)/);
  assert.match(ui, /recovered\.matchesBrowserCopy \? recovered\.text/);
  assert.match(ui, /savedSnapshotRef\.current = recovered\.matchesBrowserCopy/);
  assert.match(ui, /window\.confirm\('Your browser copy differs/);
});
