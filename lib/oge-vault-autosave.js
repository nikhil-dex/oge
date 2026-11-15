/**
 * Staging-only browser autosave coordinator for one GitHub-backed note.
 *
 * Draft content lives in sessionStorage for tab-reload recovery only.
 * It is never sent to MongoDB. sessionStorage can be evicted by the browser;
 * GitHub is the only permanent source of truth after a confirmed commit.
 */
export const VAULT_DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const VAULT_DRAFT_MAX_BYTES = 36 * 1024;
const MAX_RETRIES = 5;
const DRAFT_VERSION = 1;
const SHA = /^[0-9a-f]{40}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function vaultDraftKey(owner, repoId, id) {
  if (typeof owner !== 'string' || !owner || owner.length > 120 ||
      !Number.isSafeInteger(repoId) || repoId < 1 || !UUID.test(id || '')) {
    throw new TypeError('Invalid draft storage scope');
  }
  return 'oge-vault-preview:v1:' + encodeURIComponent(owner) + ':' + repoId + ':' + id.toLowerCase();
}

function validateDraft(value) {
  if (!value || typeof value !== 'object' || !UUID.test(value.id || '') ||
      !UUID.test(value.subjectId || '') || typeof value.heading !== 'string' ||
      value.heading.length > 160 || typeof value.answer !== 'string' ||
      value.answer.length > 20000 || !Array.isArray(value.tags) || value.tags.length > 10 ||
      value.tags.some((x) => typeof x !== 'string' || x.length > 40) ||
      typeof value.favorite !== 'boolean' ||
      (value.sha !== null && !SHA.test(value.sha || ''))) {
    throw new TypeError('Invalid vault draft');
  }
  return {
    id: value.id.toLowerCase(), subjectId: value.subjectId.toLowerCase(),
    heading: value.heading, answer: value.answer, tags: [...value.tags],
    favorite: value.favorite, sha: value.sha,
  };
}

function snapshot(value) {
  return JSON.stringify({
    subjectId: value.subjectId, heading: value.heading,
    answer: value.answer, tags: value.tags, favorite: value.favorite,
  });
}

export function readVaultDraft(storage, key, now = Date.now()) {
  try {
    const raw = storage?.getItem(key);
    if (!raw || raw.length > VAULT_DRAFT_MAX_BYTES * 2) return null;
    const parsed = JSON.parse(raw);
    if (parsed.version !== DRAFT_VERSION || !Number.isFinite(parsed.at) ||
        parsed.at > now + 60000 || now - parsed.at > VAULT_DRAFT_MAX_AGE_MS) {
      storage.removeItem(key);
      return null;
    }
    return validateDraft(parsed.draft);
  } catch {
    return null;
  }
}

export function writeVaultDraft(storage, key, draft, now = Date.now()) {
  const data = JSON.stringify({ version: DRAFT_VERSION, at: now, draft: validateDraft(draft) });
  if (data.length > VAULT_DRAFT_MAX_BYTES) throw new TypeError('Draft is too large');
  storage?.setItem(key, data);
}

export function clearVaultDraft(storage, key) {
  storage?.removeItem(key);
}

export function notesMatch(remote, local) {
  if (!remote || !local || remote.id !== local.id || !SHA.test(remote.sha || '')) return false;
  return snapshot(remote) === snapshot(local);
}

/**
 * The transport must provide:
 * - batch([{action, id, sha?, note}]) -> {results:[{id,sha,...}]}
 * - read(id) -> persisted note, or error with status 404
 *
 * The coordinator never overwrites a newer user edit: each save captures
 * a revision counter and only clears the draft when that revision is current.
 */
export function createVaultAutosave({
  storage, key, initial, batch, read, onState = () => {},
  debounceMs = 1000, setTimer = setTimeout, clearTimer = clearTimeout,
  now = Date.now, isOnline = () => true,
} = {}) {
  if (typeof batch !== 'function' || typeof read !== 'function' ||
      typeof key !== 'string' || !storage) throw new TypeError('Missing autosave dependency');
  let draft = validateDraft(initial);
  let revision = 0;
  let timer = null;
  let saving = false;
  let stopped = false;
  let retry = 0;
  let status = draft.sha === null ? 'new' : 'synced';
  let lastError = '';
  let conflict = null;
  let inflight = null;

  function state() {
    return { draft: { ...draft, tags: [...draft.tags] }, status, lastError, conflict, retry, saving };
  }
  function emit(next, error = '') {
    status = next;
    lastError = error;
    onState(state());
  }
  function cancelTimer() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }
  function schedule(delay) {
    if (stopped || conflict) return;
    cancelTimer();
    timer = setTimer(() => {
      timer = null;
      void flush();
    }, delay);
  }
  function persist() {
    try {
      writeVaultDraft(storage, key, draft, now());
    } catch {
      emit('storage-error', 'Browser draft storage is unavailable. Keep this tab open.');
      return false;
    }
    return true;
  }
  function edit(patch) {
    if (stopped) throw new Error('Autosave stopped');
    // A conflict must be resolved explicitly; preserve the local edit.
    draft = validateDraft({ ...draft, ...patch });
    revision++;
    if (!persist()) return state();
    if (conflict) {
      emit('conflict', 'A newer version exists on GitHub. Review before saving.');
      return state();
    }
    retry = 0;
    emit(isOnline() ? 'pending' : 'offline');
    if (isOnline()) schedule(debounceMs);
    return state();
  }
  async function reconcile(local, originalSha) {
    try {
      const remote = await read(local.id);
      if (notesMatch(remote, local)) return { kind: 'saved', remote };
      if (originalSha === null || remote.sha !== originalSha) return { kind: 'conflict', remote };
      return { kind: 'retry' };
    } catch (error) {
      if (error?.status === 404) return originalSha === null
        ? { kind: 'retry' } : { kind: 'conflict', remote: null };
      return { kind: 'unknown' };
    }
  }
  async function flush() {
    if (stopped || saving || conflict || status === 'storage-error') return state();
    cancelTimer();
    if (!isOnline()) { emit('offline'); return state(); }
    if (!draft.heading.trim() || !draft.answer.trim()) {
      emit('incomplete', 'Enter a title and note content before syncing.');
      return state();
    }
    const local = { ...draft, tags: [...draft.tags] };
    const ticket = revision;
    saving = true;
    inflight = local;
    emit('saving');
    try {
      const action = local.sha ? 'update' : 'create';
      const response = await batch([{
        action, id: local.id,
        ...(local.sha ? { sha: local.sha } : {}),
        note: {
          subjectId: local.subjectId, heading: local.heading,
          answer: local.answer, tags: local.tags, favorite: local.favorite,
        },
      }]);
      const saved = response?.results?.[0];
      if (!notesMatch(saved, local)) throw Object.assign(new Error('GitHub save not confirmed'), { status: 503 });
      draft = { ...draft, sha: saved.sha };
      retry = 0;
      if (revision === ticket) {
        clearVaultDraft(storage, key);
        emit('synced');
      } else {
        persist();
        emit('pending');
        schedule(debounceMs);
      }
    } catch (error) {
      const resolution = await reconcile(local, local.sha);
      if (resolution.kind === 'saved') {
        draft = { ...draft, sha: resolution.remote.sha };
        retry = 0;
        if (revision === ticket) {
          clearVaultDraft(storage, key);
          emit('synced');
        } else {
          persist();
          emit('pending');
          schedule(debounceMs);
        }
      } else if (resolution.kind === 'conflict' ||
          error?.status === 409 && resolution.kind !== 'unknown') {
        conflict = { remote: resolution.remote, deleted: !resolution.remote };
        emit('conflict', 'A conflicting change was detected. Your local draft is preserved.');
      } else {
        retry++;
        if (!isOnline()) emit('offline', 'Not connected. Draft kept in this tab.');
        else if (retry > MAX_RETRIES) emit('error', 'Could not confirm GitHub save. Retry manually.');
        else {
          emit('retrying', 'GitHub save was not confirmed. Retrying after checking the remote note.');
          schedule(Math.min(30000, 1000 * 2 ** (retry - 1)));
        }
      }
    } finally {
      saving = false;
      inflight = null;
    }
    return state();
  }
  function restore() {
    const saved = readVaultDraft(storage, key, now());
    if (saved) {
      if (saved.id !== draft.id || saved.subjectId !== draft.subjectId) return state();
      draft = saved;
      revision++;
      emit('recovered', 'Unsynced changes recovered from this browser tab.');
    }
    return state();
  }
  function retryNow() {
    if (stopped || conflict) return state();
    retry = 0;
    emit('pending');
    schedule(0);
    return state();
  }
  function discardConflict(remote) {
    if (!conflict) return state();
    const chosen = remote ?? conflict.remote;
    if (!chosen || chosen.id !== draft.id) throw new TypeError('No remote note exists to restore');
    draft = validateDraft(chosen);
    conflict = null;
    retry = 0;
    revision++;
    clearVaultDraft(storage, key);
    emit('synced');
    return state();
  }
  function stop() {
    stopped = true;
    cancelTimer();
  }
  return { edit, flush, restore, retryNow, discardConflict, stop, getState: state };
}
