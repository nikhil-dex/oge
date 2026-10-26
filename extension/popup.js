const $ = (id) => document.getElementById(id);
const baseUrl = $('baseUrl');
const tokenInput = $('token');
const categoryInput = $('category');
const statusEl = $('status');

function status(message, error = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', error);
}
function normalizeBase(value) {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use a valid HTTP or HTTPS app URL.');
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
$('saveSettings').addEventListener('click', async () => {
  try {
    const origin = normalizeBase(baseUrl.value);
    if (!await ensureHostPermission(origin)) throw new Error('Allow this site in the extension permission prompt to connect.');
    const token = tokenInput.value.trim();
    if (!/^oge_[A-Za-z0-9_-]{40,60}$/.test(token)) throw new Error('Paste a valid OgeNotes extension token.');
    await chrome.storage.local.set({ baseUrl: origin, token, category: categoryInput.value.trim().slice(0, 40) });
    baseUrl.value = origin;
    status('Connection saved in this browser.');
  } catch (error) { status(error.message || 'Could not save settings.', true); }
});
$('saveTab').addEventListener('click', async () => {
  try {
    const origin = normalizeBase(baseUrl.value);
    if (!await ensureHostPermission(origin)) throw new Error('Allow this site in the extension permission prompt to connect.');
    const token = tokenInput.value.trim();
    if (!/^oge_[A-Za-z0-9_-]{40,60}$/.test(token)) throw new Error('Paste a valid OgeNotes extension token first.');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || !/^https?:\/\//i.test(tab.url)) throw new Error('This browser page cannot be saved. Open a normal website first.');
    const saved = await chrome.storage.local.get(['category']);
    const response = await fetch(origin + '/api/extension/save-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ title: (tab.title || tab.url).slice(0, 120), url: tab.url, description: '', category: (categoryInput.value || saved.category || 'Browser').slice(0, 40), tags: ['browser'] }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Could not save this tab.');
    await chrome.storage.local.set({ baseUrl: origin, token, category: categoryInput.value.trim().slice(0, 40) });
    status('Saved “' + data.title + '” to OgeNotes.');
  } catch (error) { status(error.message || 'Could not save this tab.', true); }
});
loadSettings().catch(() => status('Could not load saved settings.', true));
