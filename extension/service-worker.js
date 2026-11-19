// All OgeNotes requests are made from the extension service worker.
// The floating content script never receives the bearer token or app origin.
const TOKEN_PATTERN = /^oge_[A-Za-z0-9_-]{40,60}$/;
const EXTENSION_ACTIONS = new Set(['CREATE_QUICK_NOTE', 'CREATE_VAULT_QUICK_NOTE', 'CREATE_VAULT_NOTE', 'UPDATE_VAULT_NOTE', 'SAVE_CURRENT_TAB', 'GET_PROFILE_LINKS', 'VISIT_PROFILE_LINK', 'GET_SUBJECTS', 'GET_THEME', 'SET_THEME', 'CREATE_LEARNING_TRACK', 'OPEN_LEARNING_TRACKS', 'OPEN_VAULT_NOTE']);
const LINK_KINDS = new Set(['github', 'linkedin', 'portfolio']);

function normalizeBase(value) {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
    throw new Error('Enter a valid HTTPS OgeNotes origin in the extension popup.');
  }
  return url.origin;
}
async function getConnection() {
  const stored = await chrome.storage.local.get(['baseUrl', 'token']);
  if (!stored.baseUrl || !TOKEN_PATTERN.test(stored.token || '')) {
    throw new Error('Connect the extension from its toolbar popup first.');
  }
  const origin = normalizeBase(stored.baseUrl);
  if (!await chrome.permissions.contains({ origins: [origin + '/*'] })) {
    throw new Error('Grant OgeNotes site permission from the Connect tab.');
  }
  return { origin, token: stored.token };
}
async function apiRequest(path, options = {}) {
  const { origin, token } = await getConnection();
  const response = await fetch(origin + path, {
    ...options,
    cache: 'no-store',
    redirect: 'error',
    headers: { Authorization: 'Bearer ' + token, ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'OgeNotes could not complete this request.');
  return data;
}
function validWebsiteUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
  } catch { return false; }
}
async function handleAction(message, sender) {
  // Only extension-injected content scripts in real tabs can use this channel.
  if (sender.id !== chrome.runtime.id || !sender.tab?.id ||
      !validWebsiteUrl(sender.tab.url) || !EXTENSION_ACTIONS.has(message?.type)) {
    throw new Error('Unsupported extension action.');
  }
  if (message.type === 'GET_THEME') {
    const stored = await chrome.storage.local.get(['ogeTheme', 'baseUrl']);
    let isOgePage = false;
    try { isOgePage = new URL(sender.tab.url).origin === normalizeBase(stored.baseUrl); }
    catch { /* Not connected yet. */ }
    return { theme: stored.ogeTheme === 'light' ? 'light' : 'dark', isOgePage };
  }
  if (message.type === 'SET_THEME') {
    // Only a page on the user's configured Oge origin may set the global
    // widget theme. Ordinary websites cannot change the stored appearance.
    const { origin } = await getConnection();
    if (new URL(sender.tab.url).origin !== origin || !['dark', 'light'].includes(message.theme)) {
      throw new Error('Only your connected OgeNotes site can change the widget theme.');
    }
    await chrome.storage.local.set({ ogeTheme: message.theme });
    return { theme: message.theme };
  }
  if (message.type === 'CREATE_QUICK_NOTE') {
    const content = message.content;
    if (typeof content !== 'string' || !content.trim() || content.length > 20000) {
      throw new Error('Write a note of up to 20,000 characters.');
    }
    const subjectSlug = message.subjectSlug;
    if (typeof subjectSlug !== 'string' || subjectSlug.length > 100) {
      throw new Error('Choose a valid destination.');
    }
    const data = await apiRequest('/api/extension/quick-note', {
      method: 'POST', body: JSON.stringify({ content, subjectSlug }),
    });
    return { title: data.title, destination: data.destination, subject: data.subject || null };
  }
  if (message.type === 'CREATE_VAULT_QUICK_NOTE') {
    if (typeof message.content !== 'string' || !message.content.trim() ||
        message.content.length > 20000 ||
        typeof message.captureId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(message.captureId))
      throw new Error('Write a Quick Note before saving.');
    const data = await apiRequest('/api/extension/vault-quick-note', {
      method: 'POST', body: JSON.stringify({
        content: message.content, captureId: message.captureId,
      }),
    });
    if (data.confirmed !== true || data.destination !== 'quick-notes' ||
        !/^[a-f0-9]{40}$/i.test(data.sha || ''))
      throw new Error('Quick Note Save was not confirmed. Keep your editor copy.');
    return { id: data.id, sha: data.sha, title: data.title,
      destination: 'quick-notes', confirmed: true,
      alreadySaved: data.alreadySaved === true };
  }
  if (message.type === 'CREATE_VAULT_NOTE' || message.type === 'UPDATE_VAULT_NOTE') {
    // The explicit GitHub destination is selected only after the subject
    // service reports a connected owner. Keep a stable ID across retries.
    if (typeof message.content !== 'string' || !message.content.trim() ||
        message.content.length > 20000 ||
        typeof message.subjectSlug !== 'string' ||
        !/^[a-f0-9-]{36}$/i.test(message.subjectSlug) ||
        typeof message.captureId !== 'string' ||
        !/^[a-f0-9-]{36}$/i.test(message.captureId)) {
      throw new Error('Select a subject and write a note of up to 20,000 characters.');
    }
    const updating = message.type === 'UPDATE_VAULT_NOTE';
    if (updating && !/^[a-f0-9]{40}$/i.test(message.sha || ''))
      throw new Error('The saved Note revision is missing. Open the Note in Oge to edit it.');
    const data = await apiRequest('/api/extension/vault-note', {
      method: updating ? 'PUT' : 'POST',
      body: JSON.stringify({
        content: message.content, subjectSlug: message.subjectSlug,
        captureId: message.captureId,
        ...(updating ? { sha: message.sha } : {}),
      }),
    });
    if (data.confirmed !== true || data.destination !== 'vault')
      throw new Error('GitHub Save was not confirmed. Keep your editor copy.');
    if (!/^[a-f0-9]{40}$/i.test(data.sha || ''))
      throw new Error('GitHub Save returned no revision. Your editor copy is retained.');
    return { id: data.id, sha: data.sha, title: data.title,
      subject: data.subject, destination: 'vault',
      confirmed: true, alreadySaved: data.alreadySaved === true };
  }
  if (message.type === 'OPEN_VAULT_NOTE') {
    // A user-clicked shortcut, never an automatic new tab after Save.
    const id = message.id;
    if (typeof id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
      throw new Error('Invalid saved Note link.');
    const { origin } = await getConnection();
    await chrome.tabs.create({ url: origin + '/vault/notes?note=' + encodeURIComponent(id.toLowerCase()) });
    return { opened: true };
  }
  if (message.type === 'CREATE_LEARNING_TRACK') {
    // A malicious web page cannot choose a different URL; use the browser's tab.
    const title = message.title;
    if (typeof title !== 'string' || !title.trim() || title.length > 120)
      throw new Error('Enter a learning track name (up to 120 characters).');
    const videosPerDay = message.videosPerDay;
    const totalVideos = message.totalVideos;
    if (!Number.isInteger(videosPerDay) || videosPerDay < 1 || videosPerDay > 20 ||
        (totalVideos !== null && (!Number.isInteger(totalVideos) || totalVideos < 1 || totalVideos > 10000)))
      throw new Error('Choose valid daily and total video counts.');
    const data = await apiRequest('/api/extension/learning-track', {
      method: 'POST',
      body: JSON.stringify({ url: sender.tab.url, title, videosPerDay, totalVideos }),
    });
    return { title: data.track.title };
  }
  if (message.type === 'OPEN_LEARNING_TRACKS') {
    // Never trust a target origin or path from a possibly hostile web page.
    const { origin } = await getConnection();
    await chrome.tabs.create({ url: origin + '/learning-tracks', active: true });
    return { opened: true };
  }
  if (message.type === 'SAVE_CURRENT_TAB') {
    const url = sender.tab.url;
    const data = await apiRequest('/api/extension/save-link', {
      method: 'POST',
      body: JSON.stringify({
        title: (sender.tab.title || url).slice(0, 120), url, description: '',
        category: 'Browser', tags: ['browser'],
      }),
    });
    return { title: data.title };
  }
  if (message.type === 'GET_SUBJECTS') {
    const data = await apiRequest('/api/extension/subjects');
    return { subjects: Array.isArray(data.subjects) ? data.subjects : [],
      vaultReady: data.vaultReady === true };
  }
  if (message.type === 'GET_PROFILE_LINKS') {
    const data = await apiRequest('/api/extension/profile-links');
    // Only validated URLs are returned; no token or account identifiers.
    const links = {};
    for (const kind of LINK_KINDS) {
      if (typeof data.links?.[kind] === 'string') links[kind] = data.links[kind];
    }
    return { links };
  }
  if (message.type === 'VISIT_PROFILE_LINK') {
    if (!LINK_KINDS.has(message.kind)) throw new Error('Unknown profile link.');
    // Always refetch current URL from the server rather than trust a link
    // supplied by a potentially compromised webpage.
    const data = await apiRequest('/api/extension/profile-links');
    const url = data.links?.[message.kind];
    if (typeof url !== 'string' || !validWebsiteUrl(url) || !url.startsWith('https://')) {
      throw new Error('This profile link is unavailable.');
    }
    await chrome.tabs.create({ url, active: true });
    return { opened: true };
  }
  throw new Error('Unsupported extension action.');
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!EXTENSION_ACTIONS.has(message?.type)) return false;
  handleAction(message, sender)
    .then((data) => sendResponse({ ok: true, ...data }))
    .catch((error) => sendResponse({ ok: false, error: error.message || 'Extension request failed.' }));
  return true;
});
