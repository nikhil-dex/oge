(() => {
  if (window.top !== window || document.getElementById('oge-floating-toolbelt-host')) return;
  const host = document.createElement('div');
  host.id = 'oge-floating-toolbelt-host';
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:18px;bottom:18px;opacity:1;transition:opacity .45s ease';
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = [
    '*{box-sizing:border-box}button,textarea,select{font:inherit}',
    'button,textarea,select{outline-offset:2px}@media(prefers-reduced-motion:reduce){:host{transition:none!important}}',
    '.launcher{width:44px;height:44px;border:1px solid #ffffff55;border-radius:14px;background:#316b50;color:#fff;box-shadow:0 8px 26px #10251b40;font:800 19px system-ui;cursor:grab;touch-action:none;user-select:none;letter-spacing:-.05em;transition:box-shadow .18s,background .18s}.launcher:hover{background:#23563d;box-shadow:0 9px 28px #10251b55}.launcher:active{cursor:grabbing}.launcher.is-panel-open{visibility:hidden;pointer-events:none}',
    '.panel{position:fixed;left:16px;top:16px;right:auto;bottom:auto;width:330px;min-width:265px;max-width:calc(100vw - 24px);height:360px;min-height:235px;max-height:calc(100vh - 75px);resize:both;overflow:auto;border:1px solid #dbe5de;border-radius:14px;background:#fff;color:#1d2d22;box-shadow:0 18px 48px #10251b35;font:12px/1.4 system-ui,-apple-system,sans-serif}',
    '.hidden{display:none}.resize-corner{position:sticky;bottom:0;float:right;width:24px;height:24px;margin-top:-24px;display:grid;place-items:center;border:0;border-top-left-radius:8px;color:#657a6d;background:#f1f6f2;cursor:nwse-resize;touch-action:none;user-select:none;font-size:15px}.resize-corner-left{float:left;border-radius:0 8px 0 0;cursor:nesw-resize}.top{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid #e8eee9;cursor:grab;touch-action:none;user-select:none;background:#fbfcfb}.top:active{cursor:grabbing}',
    '.mark{display:grid;place-items:center;width:24px;height:24px;border-radius:7px;background:#316b50;color:white;font-size:12px;font-weight:800}.heading{flex:1;font-size:12px;font-weight:750;letter-spacing:.01em}',
    '.close{padding:2px 6px;border:0;background:transparent;color:#536c59;font-size:22px;cursor:pointer}',
    '.body{padding:11px 12px}.body[hidden]{display:none}.hint{margin:0 0 9px;color:#6b7b70;font-size:10px;line-height:1.45}',
    'textarea{display:block;width:100%;height:116px;min-height:75px;padding:10px;resize:vertical;border:1px solid #d5e0d8;border-radius:8px;color:#15251b;background:#fff;font:12px/1.5 ui-monospace,monospace;outline-color:#40795e}',
    '.primary{display:block;width:100%;margin-top:9px;padding:9px;border:0;border-radius:8px;background:#316b50;color:white;font-size:11px;font-weight:750;cursor:pointer}.primary:hover{background:#23563d}',
    'button:disabled{opacity:.65;cursor:wait}.status{min-height:0;margin:0 12px;color:#316b50;font-size:10px;overflow-wrap:anywhere}.status:not(:empty){padding:6px 0}.error{color:#b42318}',
    '.belt{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;padding:7px 10px;border-top:1px solid #e7eee8;background:#fafcfb}',
    '.belt button{padding:7px 2px;border:1px solid transparent;border-radius:7px;background:transparent;color:#52685a;font-size:10px;font-weight:600;cursor:pointer}',
    '.belt button.selected{border-color:#b6d8bf;background:#e5f3e9;color:#275d39}',
    '.link{display:grid;gap:8px;padding:9px 0;border-bottom:1px solid #e4eee6}.link:last-child{border:0}.link strong{font-size:12px}',
    '.address{display:block;color:#6c7b71;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.link-actions{display:flex;gap:8px}.link-actions button{flex:1;padding:8px;border:1px solid #a9c7b1;border-radius:7px;background:#eff7f0;color:#255837;font-size:11px;cursor:pointer}',
    '.empty{font-size:11px;color:#637568}.subject-label{display:block;margin:8px 0 4px;font-size:10px;font-weight:700;color:#546d5b}.subject-select{display:block;width:100%;padding:8px;border:1px solid #d5e0d8;border-radius:8px;background:#fff;color:#15251b;font:11px system-ui}:focus-visible{outline:2px solid #40795e;outline-offset:2px}',
  ].join('');
  const panel = document.createElement('section');
  panel.className = 'panel hidden';
  panel.setAttribute('aria-label', 'OgeNotes floating toolbelt');
  // HTML is static extension-owned markup; user content uses textContent.
  panel.innerHTML = [
    '<header class="top"><span class="mark">O</span><strong class="heading">OgeNotes</strong><button class="close" type="button" aria-label="Close toolbelt">×</button></header>',
    '<div class="body" data-panel="note"><p class="hint">First line = title · Choose a destination below.</p><textarea maxlength="20000" aria-label="Quick note" placeholder="Heading&#10;&#10;Your note…"></textarea><label class="subject-label" for="oge-note-subject">Save to</label><select class="subject-select" id="oge-note-subject" aria-label="Choose note destination"><option value="">Quick Notes (default)</option></select><button class="primary" type="button" data-save-note>Save to Quick Notes</button></div>',
    '<div class="body" data-panel="url" hidden><p class="hint">Save the current website link directly to your Saved Links collection.</p><button class="primary" type="button" data-save-url>Save page link →</button></div>',
    '<div class="body" data-panel="links" hidden><p class="hint">Your social and portfolio URLs from OgeNotes Profile.</p><div data-links><p class="empty">Open My Links to load URLs.</p></div></div>',
    '<p class="status" role="status" aria-live="polite"></p>',
    '<nav class="belt" aria-label="OgeNotes tools"><button class="selected" data-tool="note" type="button">✎ Quick note</button><button data-tool="url" type="button">↗ Saved Links</button><button data-tool="links" type="button">☷ My links</button></nav>',
    '<button class="resize-corner resize-corner-left" type="button" aria-label="Resize widget from left corner" title="Drag left or down to resize">↙</button>',
    '<button class="resize-corner" type="button" aria-label="Resize widget width and height" title="Drag to resize width and height">↘</button>',
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
  // The panel is viewport-fixed, so it can grow in either dimension
  // independently of the draggable launcher and avoid clipping at page edges.
  const GAP = 8;
  const MIN_PANEL_WIDTH = 265;
  const MIN_PANEL_HEIGHT = 235;
  const clamp = (n, low, high) => Math.min(Math.max(n, low), Math.max(low, high));
  function positionPanel() {
    if (panel.classList.contains('hidden')) return;
    const launcherBounds = launcher.getBoundingClientRect();
    const maxWidth = Math.max(MIN_PANEL_WIDTH, window.innerWidth - GAP * 2);
    const maxHeight = Math.max(MIN_PANEL_HEIGHT, window.innerHeight - GAP * 2);
    const width = Math.min(panel.offsetWidth, maxWidth);
    const height = Math.min(panel.offsetHeight, maxHeight);
    const x = clamp(launcherBounds.right - width, GAP, window.innerWidth - width - GAP);
    // Above the button when possible, below it when there is more room.
    const above = launcherBounds.top - height - GAP;
    const below = launcherBounds.bottom + GAP;
    const preferred = above >= GAP ? above :
      window.innerHeight - below >= height ? below : above;
    panel.style.left = clamp(x, GAP, window.innerWidth - width - GAP) + 'px';
    panel.style.top = clamp(preferred, GAP, window.innerHeight - height - GAP) + 'px';
  }
  let idleTimer;
  const IDLE_DELAY_MS = 12000;
  function wake() {
    host.style.opacity = '1';
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      // Stay discoverable while idle; never hide the editing surface entirely.
      host.style.opacity = panel.classList.contains('hidden') ? '.38' : '.78';
    }, IDLE_DELAY_MS);
  }
  for (const name of ['pointermove', 'keydown', 'wheel', 'touchstart']) {
    window.addEventListener(name, wake, { passive: true });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) host.style.opacity = '.38';
    else wake();
  });
  shadow.addEventListener('pointerdown', wake);
  shadow.addEventListener('focusin', wake);
  function openPanel(open) {
    panel.classList.toggle('hidden', !open);
    // Keep the launcher as a positioning anchor while the open panel hides it.
    // Closing restores the draggable O button.
    launcher.classList.toggle('is-panel-open', open);
    launcher.setAttribute('aria-expanded', String(open));
    launcher.setAttribute('aria-hidden', String(open));
    launcher.tabIndex = open ? -1 : 0;
    wake();
    if (open) {
      positionPanel();
      if (active === 'note') { note.focus(); void loadSubjects(); }
    }
  }
  let launcherDrag = null;
  let ignoreLauncherClick = false;
  function placeLauncher(x, y) {
    host.style.left = clamp(x, GAP, window.innerWidth - launcher.offsetWidth - GAP) + 'px';
    host.style.top = clamp(y, GAP, window.innerHeight - launcher.offsetHeight - GAP) + 'px';
    host.style.right = 'auto';
    host.style.bottom = 'auto';
    positionPanel();
  }
  launcher.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const rect = launcher.getBoundingClientRect();
    launcherDrag = { id: event.pointerId, startX: event.clientX, startY: event.clientY,
      left: rect.left, top: rect.top, moved: false };
    launcher.setPointerCapture(event.pointerId);
    wake();
  });
  launcher.addEventListener('pointermove', (event) => {
    if (!launcherDrag || launcherDrag.id !== event.pointerId) return;
    const dx = event.clientX - launcherDrag.startX;
    const dy = event.clientY - launcherDrag.startY;
    if (!launcherDrag.moved && Math.hypot(dx, dy) < 5) return;
    launcherDrag.moved = true;
    placeLauncher(launcherDrag.left + dx, launcherDrag.top + dy);
  });
  function finishLauncherDrag(event) {
    if (!launcherDrag || launcherDrag.id !== event.pointerId) return;
    if (launcherDrag.moved) ignoreLauncherClick = true;
    launcherDrag = null;
  }
  launcher.addEventListener('pointerup', finishLauncherDrag);
  launcher.addEventListener('pointercancel', finishLauncherDrag);
  launcher.addEventListener('click', (event) => {
    if (ignoreLauncherClick) {
      ignoreLauncherClick = false;
      event.preventDefault();
      return;
    }
    openPanel(panel.classList.contains('hidden'));
  });
  panel.querySelector('.close').addEventListener('click', () => openPanel(false));
  panel.querySelectorAll('[data-tool]').forEach((button) => {
    button.addEventListener('click', () => setPanel(button.dataset.tool));
  });
  // Preserve the original page-shortcut protection while typing notes.
  const stopPageShortcutsWhileTyping = (event) => {
    if (panel.classList.contains('hidden') || shadow.activeElement !== note) return;
    event.stopPropagation();
    event.stopImmediatePropagation();
  };
  for (const name of ['keydown', 'keyup', 'keypress']) {
    window.addEventListener(name, stopPageShortcutsWhileTyping, true);
  }
  // Header movement remains available when expanded; dragging the launcher
  // itself now works without opening the panel first.
  const handle = panel.querySelector('.top');
  let headerDrag = null;
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest('button')) return;
    const rect = launcher.getBoundingClientRect();
    headerDrag = { id: event.pointerId, x: event.clientX, y: event.clientY,
      left: rect.left, top: rect.top };
    handle.setPointerCapture(event.pointerId);
    wake();
  });
  handle.addEventListener('pointermove', (event) => {
    if (!headerDrag || headerDrag.id !== event.pointerId) return;
    placeLauncher(headerDrag.left + event.clientX - headerDrag.x,
      headerDrag.top + event.clientY - headerDrag.y);
  });
  handle.addEventListener('pointerup', () => { headerDrag = null; });
  handle.addEventListener('pointercancel', () => { headerDrag = null; });

  const resizeHandles = panel.querySelectorAll('.resize-corner');
  let resizeDrag = null;
  for (const resizeHandle of resizeHandles) {
  resizeHandle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const rect = panel.getBoundingClientRect();
    resizeDrag = { id: event.pointerId, x: event.clientX, y: event.clientY,
      width: rect.width, height: rect.height, left: rect.left, top: rect.top,
      fromLeft: resizeHandle.classList.contains('resize-corner-left') };
    resizeHandle.setPointerCapture(event.pointerId);
    wake();
  });
  resizeHandle.addEventListener('pointermove', (event) => {
    if (!resizeDrag || resizeDrag.id !== event.pointerId) return;
    const dx = event.clientX - resizeDrag.x;
    const width = resizeDrag.fromLeft
      ? clamp(resizeDrag.width - dx, MIN_PANEL_WIDTH, resizeDrag.left + resizeDrag.width - GAP)
      : clamp(resizeDrag.width + dx, MIN_PANEL_WIDTH, window.innerWidth - resizeDrag.left - GAP);
    const height = clamp(resizeDrag.height + event.clientY - resizeDrag.y,
      MIN_PANEL_HEIGHT, window.innerHeight - resizeDrag.top - GAP);
    panel.style.width = width + 'px';
    if (resizeDrag.fromLeft) panel.style.left = resizeDrag.left + resizeDrag.width - width + 'px';
    panel.style.height = height + 'px';
    wake();
  });
  resizeHandle.addEventListener('pointerup', () => { resizeDrag = null; });
  resizeHandle.addEventListener('pointercancel', () => { resizeDrag = null; });
  }
  window.addEventListener('resize', () => {
    const width = Math.min(panel.offsetWidth, window.innerWidth - GAP * 2);
    const height = Math.min(panel.offsetHeight, window.innerHeight - GAP * 2);
    panel.style.width = Math.max(0, width) + 'px';
    panel.style.height = Math.max(0, height) + 'px';
    if (host.style.left) {
      const rect = launcher.getBoundingClientRect();
      placeLauncher(rect.left, rect.top);
    } else positionPanel();
  });
  wake();

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
      setStatus('Page link saved to Saved Links: “' + result.title + '”.');
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
