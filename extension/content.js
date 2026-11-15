(() => {
  if (window.top !== window || document.getElementById('oge-floating-toolbelt-host')) return;
  const host = document.createElement('div');
  host.id = 'oge-floating-toolbelt-host';
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:18px;bottom:18px';
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = [
    '*{box-sizing:border-box}button,textarea{font:inherit}',
    '.launcher{width:48px;height:48px;border:0;border-radius:50%;background:#40795e;color:#fff;box-shadow:0 8px 25px #1f342766;font:800 22px system-ui;cursor:pointer}',
    '.panel{position:absolute;right:0;bottom:60px;width:min(355px,calc(100vw - 28px));max-height:min(580px,calc(100vh - 100px));overflow:auto;border:1px solid #d9e7dd;border-radius:14px;background:#fcfdfb;color:#1d2d22;box-shadow:0 18px 60px #10251b45;font:13px/1.45 system-ui,-apple-system,sans-serif}',
    '.hidden{display:none}.top{display:flex;align-items:center;gap:10px;padding:13px 14px;border-bottom:1px solid #e4eee6;cursor:move;touch-action:none;user-select:none}',
    '.mark{display:grid;place-items:center;width:30px;height:30px;border-radius:8px;background:#40795e;color:white;font-weight:800}.heading{flex:1;font-weight:750}',
    '.close{padding:2px 6px;border:0;background:transparent;color:#536c59;font-size:22px;cursor:pointer}',
    '.body{padding:14px}.body[hidden]{display:none}.hint{margin:0 0 10px;color:#6b7b70;font-size:11px;line-height:1.55}',
    'textarea{display:block;width:100%;height:168px;padding:11px;resize:vertical;border:1px solid #cfdbd2;border-radius:8px;color:#15251b;background:#fff;font:13px/1.5 ui-monospace,monospace;outline-color:#40795e}',
    '.primary{display:block;width:100%;margin-top:12px;padding:11px;border:0;border-radius:8px;background:#40795e;color:white;font-size:12px;font-weight:750;cursor:pointer}',
    'button:disabled{opacity:.65;cursor:wait}.status{min-height:16px;margin:10px 14px 0;color:#40795e;font-size:11px;overflow-wrap:anywhere}.error{color:#b42318}',
    '.belt{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;padding:10px 12px;border-top:1px solid #e2ebe4}',
    '.belt button{padding:9px 2px;border:1px solid transparent;border-radius:8px;background:transparent;color:#52685a;font-size:11px;cursor:pointer}',
    '.belt button.selected{border-color:#b6d8bf;background:#e5f3e9;color:#275d39}',
    '.link{display:grid;gap:8px;padding:9px 0;border-bottom:1px solid #e4eee6}.link:last-child{border:0}.link strong{font-size:12px}',
    '.address{display:block;color:#6c7b71;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.link-actions{display:flex;gap:8px}.link-actions button{flex:1;padding:8px;border:1px solid #a9c7b1;border-radius:7px;background:#eff7f0;color:#255837;font-size:11px;cursor:pointer}',
    '.empty{font-size:12px;color:#637568}.subject-label{display:block;margin:10px 0 6px;font-size:11px;font-weight:700;color:#546d5b}.subject-select{display:block;width:100%;padding:10px;border:1px solid #cfdbd2;border-radius:8px;background:#fff;color:#15251b;font:12px system-ui}:focus-visible{outline:2px solid #40795e;outline-offset:2px}',
  ].join('');
  const panel = document.createElement('section');
  panel.className = 'panel hidden';
  panel.setAttribute('aria-label', 'OgeNotes floating toolbelt');
  // HTML is static extension-owned markup; user content uses textContent.
  panel.innerHTML = [
    '<header class="top"><span class="mark">O</span><strong class="heading">OgeNotes Toolbelt</strong><button class="close" type="button" aria-label="Close toolbelt">×</button></header>',
    '<div class="body" data-panel="note"><p class="hint">The first line becomes the title. Choose a subject to save in Notes, or leave Quick Notes selected.</p><textarea maxlength="20000" aria-label="Quick note" placeholder="Heading&#10;&#10;Your note…"></textarea><label class="subject-label" for="oge-note-subject">Save to</label><select class="subject-select" id="oge-note-subject" aria-label="Choose note destination"><option value="">Quick Notes (default)</option></select><button class="primary" type="button" data-save-note>Save to Quick Notes</button></div>',
    '<div class="body" data-panel="url" hidden><p class="hint">Save this website to your personal Saved Links.</p><button class="primary" type="button" data-save-url>Save current page ↗</button></div>',
    '<div class="body" data-panel="links" hidden><p class="hint">Your social and portfolio URLs from OgeNotes Profile.</p><div data-links><p class="empty">Open My Links to load URLs.</p></div></div>',
    '<p class="status" role="status" aria-live="polite"></p>',
    '<nav class="belt" aria-label="OgeNotes tools"><button class="selected" data-tool="note" type="button">✎ Quick note</button><button data-tool="url" type="button">↗ Save URL</button><button data-tool="links" type="button">☷ My links</button></nav>',
  ].join('');
  const launcher = document.createElement('button');
  launcher.className = 'launcher';
  launcher.type = 'button';
  launcher.textContent = 'O';
  launcher.title = 'Open OgeNotes floating toolbelt';
  launcher.setAttribute('aria-label', 'Open OgeNotes floating toolbelt');
  launcher.setAttribute('aria-expanded', 'false');
  shadow.append(style, panel, launcher);
  const note = panel.querySelector('textarea');
  const subjectSelect = panel.querySelector('#oge-note-subject');
  const status = panel.querySelector('.status');
  let active = 'note';
  const setStatus = (message, error = false) => {
    status.textContent = message;
    status.classList.toggle('error', error);
  };
  async function send(type, data = {}) {
    const response = await chrome.runtime.sendMessage({ type, ...data });
    if (!response?.ok) throw new Error(response?.error || 'Could not reach OgeNotes.');
    return response;
  }
  function setPanel(tool) {
    active = tool;
    for (const body of panel.querySelectorAll('[data-panel]')) body.hidden = body.dataset.panel !== tool;
    for (const button of panel.querySelectorAll('[data-tool]')) {
      button.classList.toggle('selected', button.dataset.tool === tool);
    }
    setStatus('');
    if (tool === 'note') { note.focus(); void loadSubjects(); }
    if (tool === 'links') void loadLinks();
  }
  function openPanel(open) {
    panel.classList.toggle('hidden', !open);
    launcher.setAttribute('aria-expanded', String(open));
    if (open && active === 'note') { note.focus(); void loadSubjects(); }
  }
  launcher.addEventListener('click', () => openPanel(panel.classList.contains('hidden')));
  panel.querySelector('.close').addEventListener('click', () => openPanel(false));
  panel.querySelectorAll('[data-tool]').forEach((button) => {
    button.addEventListener('click', () => setPanel(button.dataset.tool));
  });
  // Prevent host-page keyboard shortcuts while typing without suppressing
  // regular input handling inside the note editor.
  const stopPageShortcutsWhileTyping = (event) => {
    if (panel.classList.contains('hidden') || shadow.activeElement !== note) return;
    event.stopPropagation();
    event.stopImmediatePropagation();
  };
  for (const name of ['keydown', 'keyup', 'keypress']) {
    window.addEventListener(name, stopPageShortcutsWhileTyping, true);
  }
  let dragging = false;
  let originX = 0, originY = 0, startX = 0, startY = 0;
  const handle = panel.querySelector('.top');
  handle.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button')) return;
    dragging = true;
    startX = event.clientX;
    startY = event.clientY;
    const bounds = host.getBoundingClientRect();
    originX = bounds.left;
    originY = bounds.top;
    host.style.left = bounds.left + 'px';
    host.style.top = bounds.top + 'px';
    host.style.right = 'auto';
    host.style.bottom = 'auto';
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    host.style.left = Math.max(0, Math.min(window.innerWidth - host.offsetWidth, originX + event.clientX - startX)) + 'px';
    host.style.top = Math.max(0, Math.min(window.innerHeight - host.offsetHeight, originY + event.clientY - startY)) + 'px';
  });
  handle.addEventListener('pointerup', () => { dragging = false; });
  handle.addEventListener('pointercancel', () => { dragging = false; });

  const noteSave = panel.querySelector('[data-save-note]');
  async function loadSubjects() {
    const previous = subjectSelect.value;
    try {
      const result = await send('GET_SUBJECTS');
      subjectSelect.replaceChildren();
      const quick = document.createElement('option');
      quick.value = '';
      quick.textContent = 'Quick Notes (default)';
      subjectSelect.append(quick);
      for (const subject of result.subjects || []) {
        if (typeof subject.slug !== 'string' || typeof subject.name !== 'string') continue;
        const option = document.createElement('option');
        option.value = subject.slug;
        option.textContent = subject.name;
        subjectSelect.append(option);
      }
      if ([...subjectSelect.options].some((option) => option.value === previous)) {
        subjectSelect.value = previous;
      }
      updateNoteButton();
    } catch (error) {
      // Keep the default Quick Notes destination and any previously loaded subjects.
      setStatus(error.message || 'Could not load subjects.', true);
    }
  }
  function updateNoteButton() {
    noteSave.textContent = subjectSelect.value ? 'Save to selected subject →' : 'Save to Quick Notes';
  }
  subjectSelect.addEventListener('change', updateNoteButton);

  noteSave.addEventListener('click', async () => {
    if (!note.value.trim()) return setStatus('Write something before saving.', true);
    noteSave.disabled = true;
    setStatus('Saving note…');
    try {
      const result = await send('CREATE_QUICK_NOTE', { content: note.value, subjectSlug: subjectSelect.value });
      note.value = '';
      setStatus(result.destination === 'notes' ? 'Saved “' + result.title + '” to ' + result.subject + ' in Notes.' : 'Saved “' + result.title + '” to Quick Notes.');
    } catch (error) { setStatus(error.message, true); }
    finally { noteSave.disabled = false; }
  });
  const urlSave = panel.querySelector('[data-save-url]');
  urlSave.addEventListener('click', async () => {
    urlSave.disabled = true;
    setStatus('Saving website…');
    try {
      const result = await send('SAVE_CURRENT_TAB');
      setStatus('Saved “' + result.title + '” to Saved Links.');
    } catch (error) { setStatus(error.message, true); }
    finally { urlSave.disabled = false; }
  });
  async function copyUrl(url) {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Fallback for pages where the Clipboard API is not available to
      // content scripts. Never use page-supplied code or clipboard HTML.
      const input = document.createElement('textarea');
      input.value = url;
      input.style.cssText = 'position:fixed;left:-9999px;top:0';
      shadow.append(input);
      input.focus();
      input.select();
      const succeeded = document.execCommand('copy');
      input.remove();
      if (!succeeded) throw new Error('Copy failed. Open the extension popup to copy this link.');
    }
  }
  async function loadLinks() {
    const container = panel.querySelector('[data-links]');
    container.replaceChildren();
    const loading = document.createElement('p');
    loading.className = 'empty';
    loading.textContent = 'Loading profile links…';
    container.append(loading);
    try {
      const result = await send('GET_PROFILE_LINKS');
      container.replaceChildren();
      const kinds = { github: 'GitHub', linkedin: 'LinkedIn', portfolio: 'Portfolio' };
      let count = 0;
      for (const [kind, label] of Object.entries(kinds)) {
        const url = result.links?.[kind];
        if (typeof url !== 'string') continue;
        count += 1;
        const row = document.createElement('div');
        row.className = 'link';
        const title = document.createElement('strong');
        title.textContent = label;
        const address = document.createElement('span');
        address.className = 'address';
        address.textContent = url;
        address.title = url;
        const actions = document.createElement('div');
        actions.className = 'link-actions';
        const copy = document.createElement('button');
        copy.textContent = 'Copy';
        copy.type = 'button';
        copy.setAttribute('aria-label', 'Copy ' + label + ' link');
        copy.addEventListener('click', async () => {
          try { await copyUrl(url); setStatus(label + ' copied.'); }
          catch (error) { setStatus(error.message, true); }
        });
        const visit = document.createElement('button');
        visit.textContent = 'Visit ↗';
        visit.type = 'button';
        visit.setAttribute('aria-label', 'Visit ' + label + ' link');
        visit.addEventListener('click', async () => {
          try { await send('VISIT_PROFILE_LINK', { kind }); }
          catch (error) { setStatus(error.message, true); }
        });
        actions.append(copy, visit);
        row.append(title, address, actions);
        container.append(row);
      }
      if (!count) {
        const empty = document.createElement('p');
        empty.className = 'empty';
        empty.textContent = 'No social links yet. Add GitHub, LinkedIn or your portfolio in OgeNotes Profile.';
        container.append(empty);
      }
    } catch (error) {
      container.replaceChildren();
      setStatus(error.message, true);
    }
  }
})();
