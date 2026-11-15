const $ = (id) => document.getElementById(id);
const baseUrl = $('baseUrl');
const tokenInput = $('token');
const categoryInput = $('category');
const statusEl = $('status');

const TOOLS = Object.freeze({
  save: { button: 'toolSave', panel: 'savePanel' },
  links: { button: 'toolLinks', panel: 'linksPanel' },
  connect: { button: 'toolConnect', panel: 'connectPanel' },
});
const LINK_LABELS = Object.freeze({ github: 'GitHub', linkedin: 'LinkedIn', portfolio: 'Portfolio' });

function status(message, error = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', error);
}
function normalizeBase(value) {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) throw new Error('Use a valid app origin without a path.');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error('Remote app connections must use HTTPS.');
  }
  return url.origin;
}
async function ensureHostPermission(origin) {
  const granted = await chrome.permissions.contains({ origins: [origin + '/*'] });
  if (granted) return true;
  return chrome.permissions.request({ origins: [origin + '/*'] });
}
async function loadSettings() {
  const saved = await chrome.storage.local.get(['baseUrl', 'token', 'category']);
  if (saved.baseUrl) baseUrl.value = saved.baseUrl;
  if (saved.token) tokenInput.value = saved.token;
  if (saved.category) categoryInput.value = saved.category;
}
function getConnection() {
  const origin = normalizeBase(baseUrl.value);
  const token = tokenInput.value.trim();
  if (!/^oge_[A-Za-z0-9_-]{40,60}$/.test(token)) {
    throw new Error('Connect your OgeNotes extension token first, under Connect.');
  }
  return { origin, token };
}
function showTool(selected) {
  for (const [key, item] of Object.entries(TOOLS)) {
    const active = key === selected;
    $(item.panel).hidden = !active;
    $(item.button).classList.toggle('active', active);
    $(item.button).setAttribute('aria-expanded', String(active));
  }
  status('');
}
function renderProfileLinks(links) {
  const list = $('linksList');
  list.replaceChildren();
  const entries = Object.entries(LINK_LABELS).filter(([key]) => typeof links?.[key] === 'string');
  if (!entries.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No social or portfolio links saved yet. Add them on your OgeNotes Profile page.';
    list.append(empty);
    return;
  }
  for (const [key, label] of entries) {
    const url = links[key];
    const row = document.createElement('div');
    row.className = 'link-item';
    const details = document.createElement('div');
    details.className = 'link-details';
    const title = document.createElement('strong');
    title.textContent = label;
    const address = document.createElement('span');
    address.className = 'link-address';
    address.textContent = url;
    address.title = url;
    details.append(title, address);
    const actions = document.createElement('div');
    actions.className = 'link-actions';
    const copy = document.createElement('button');
    copy.className = 'secondary mini-button';
    copy.type = 'button';
    copy.textContent = 'Copy';
    copy.setAttribute('aria-label', 'Copy ' + label + ' URL');
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(url);
        status(label + ' URL copied.');
      } catch {
        status('Could not copy the ' + label + ' link.', true);
      }
    });
    const visit = document.createElement('button');
    visit.className = 'mini-button';
    visit.type = 'button';
    visit.textContent = 'Visit ↗';
    visit.setAttribute('aria-label', 'Visit ' + label + ' in a new tab');
    visit.addEventListener('click', async () => {
      try {
        const safe = new URL(url);
        if (safe.protocol !== 'https:') throw new Error('Invalid URL');
        await chrome.tabs.create({ url: safe.href });
      } catch {
        status('Could not open the ' + label + ' link.', true);
      }
    });
    actions.append(copy, visit);
    row.append(details, actions);
    list.append(row);
  }
}
async function loadProfileLinks() {
  const list = $('linksList');
  list.replaceChildren();
  const loading = document.createElement('p');
  loading.className = 'empty';
  loading.textContent = 'Loading profile links…';
  list.append(loading);
  $('refreshLinks').disabled = true;
  try {
    const { origin, token } = getConnection();
    if (!await ensureHostPermission(origin)) throw new Error('Allow the OgeNotes app connection to read your links.');
    const response = await fetch(origin + '/api/extension/profile-links', {
      headers: { Authorization: 'Bearer ' + token },
      cache: 'no-store',
      redirect: 'error',
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Could not load profile links.');
    renderProfileLinks(data.links);
  } catch (error) {
    list.replaceChildren();
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Unable to load profile links.';
    list.append(empty);
    status(error.message || 'Could not load profile links.', true);
  } finally {
    $('refreshLinks').disabled = false;
  }
}
$('toolSave').addEventListener('click', () => showTool('save'));
$('toolLinks').addEventListener('click', () => {
  showTool('links');
  void loadProfileLinks();
});
$('toolConnect').addEventListener('click', () => showTool('connect'));
$('refreshLinks').addEventListener('click', () => void loadProfileLinks());

$('saveSettings').addEventListener('click', async () => {
  try {
    const { origin, token } = getConnection();
    if (!await ensureHostPermission(origin)) throw new Error('Allow this site in the extension permission prompt to connect.');
    await chrome.storage.local.set({ baseUrl: origin, token, category: categoryInput.value.trim().slice(0, 40) });
    baseUrl.value = origin;
    status('Connection saved in this browser.');
  } catch (error) { status(error.message || 'Could not save settings.', true); }
});
$('saveTab').addEventListener('click', async () => {
  try {
    const { origin, token } = getConnection();
    if (!await ensureHostPermission(origin)) throw new Error('Allow this site in the extension permission prompt to connect.');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || !/^https?:\/\//i.test(tab.url)) throw new Error('This browser page cannot be saved. Open a normal website first.');
    const saved = await chrome.storage.local.get(['category']);
    const response = await fetch(origin + '/api/extension/save-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ title: (tab.title || tab.url).slice(0, 120), url: tab.url, description: '', category: (categoryInput.value || saved.category || 'Browser').slice(0, 40), tags: ['browser'] }),
      redirect: 'error',
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Could not save this tab.');
    await chrome.storage.local.set({ baseUrl: origin, token, category: categoryInput.value.trim().slice(0, 40) });
    status('Saved “' + data.title + '” to OgeNotes.');
  } catch (error) { status(error.message || 'Could not save this tab.', true); }
});
loadSettings().catch(() => status('Could not load saved settings.', true));
