'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  captureEditorScope, encodeLocalRecovery, parseLocalRecovery,
  normalizeEditorContent, currentCaptureMatchesPending,
} from '../../../lib/oge-vault-standalone-editor.js';

const API = '/api/vault/standalone';
const DRAFT_API = '/api/vault/standalone-drafts';

async function readJson(response) {
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value?.error || 'Vault request not verified.');
  return value;
}

function typedItems(items, kind) {
  if (!Array.isArray(items) || items.length > 300)
    throw new TypeError('Incomplete standalone capture list.');
  const format = kind === 'airnotes' ? 'ogenotes-airnote' : 'ogenotes-quick-note';
  if (items.some((entry) => entry?.format !== format ||
      typeof entry.id !== 'string' || typeof entry.content !== 'string' ||
      typeof entry.sha !== 'string')) throw new TypeError('Unexpected Vault capture list.');
  return items;
}

/**
 * M72: disposable staging owner-browser pilot only.
 * No legacy API, extension token or automatic GitHub push.
 * Local recovery is best-effort sessionStorage; permanent content lives only
 * in GitHub, temporary AES-GCM drafts only in MongoDB.
 */
export default function StandaloneVaultEditor({ ownerId, repoId }) {
  const [kind, setKind] = useState('');
  const [items, setItems] = useState([]);
  const [editor, setEditor] = useState(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [status, setStatus] = useState('Choose Quick Notes or AirNotes to begin.');
  const [error, setError] = useState('');

  const editorRef = useRef(null);
  const revisionRef = useRef(0);
  const lastDraftTextRef = useRef(null);
  const queueRef = useRef(Promise.resolve());
  const busyRef = useRef(false);
  const blockedRef = useRef(false);
  const pendingGitHubRef = useRef(null);

  function applyEditor(value) {
    editorRef.current = value;
    setEditor(value);
  }
  function resetDraft(rev = 0, last = null) {
    revisionRef.current = rev;
    lastDraftTextRef.current = last;
    setRevision(rev);
  }
  function block(reason) {
    blockedRef.current = true;
    setBlocked(true);
    setStatus('Draft outcome uncertain: no automatic retry is allowed.');
    setError(reason);
  }
  function localKey(which, id) {
    return captureEditorScope(ownerId, repoId, which, id);
  }
  function readLocal(which, id) {
    try {
      return parseLocalRecovery(sessionStorage.getItem(localKey(which, id)), which, id);
    } catch { return null; }
  }
  function clearLocal(which, id) {
    try {
      sessionStorage.removeItem(localKey(which, id));
      const pointer = captureEditorScope(ownerId, repoId, which);
      if (sessionStorage.getItem(pointer) === id)
        sessionStorage.removeItem(pointer);
    } catch { /* Browser storage is optional. */ }
  }

  // Every local editor change is preserved as an owner/repo/type/UUID-scoped
  // best-effort browser copy; never use localStorage or include credentials.
  useEffect(() => {
    if (!editor) return;
    try {
      sessionStorage.setItem(
        captureEditorScope(ownerId, repoId, editor.kind, editor.id),
        encodeLocalRecovery(editor),
      );
      if (editor.baseSha === null)
        sessionStorage.setItem(
          captureEditorScope(ownerId, repoId, editor.kind), editor.id,
        );
    } catch { /* Keep the visible editor content even if storage is denied. */ }
  }, [editor, ownerId, repoId]);

  const persist = useCallback(async (snapshot) => {
    if (blockedRef.current || pendingGitHubRef.current)
      throw new Error('Resolve an uncertain save before editing the server draft.');
    const text = normalizeEditorContent(snapshot.content);
    const operation = queueRef.current.then(async () => {
      if (blockedRef.current || pendingGitHubRef.current)
        throw new Error('An earlier save requires review.');
      if (revisionRef.current > 0 && lastDraftTextRef.current === text)
        return revisionRef.current;
      const next = revisionRef.current + 1;
      const data = await readJson(await fetch(DRAFT_API, {
        method: 'PUT', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: snapshot.kind, id: snapshot.id, revision: next,
          draft: { content: text, baseSha: snapshot.baseSha },
        }),
      }));
      if (data?.savedTo !== 'temporary-encrypted-draft' ||
          data?.committedToGitHub !== false || data?.revision !== next ||
          data?.id !== snapshot.id || data?.kind !== snapshot.kind)
        throw new Error('Encrypted draft acknowledgement unverified.');
      revisionRef.current = next;
      lastDraftTextRef.current = text;
      setRevision(next);
      setStatus('Encrypted temporary draft saved. Press Save to commit to GitHub.');
      return next;
    });
    queueRef.current = operation;
    try { return await operation; }
    catch {
      blockedRef.current = true;
      setBlocked(true);
      setStatus('Encrypted autosave outcome uncertain. Browser copy kept.');
      throw new Error('Cannot retry the same draft revision. Re-read the server draft first.');
    }
  }, []);

  // Debounced autosave is MongoDB encrypted draft ONLY. Never GitHub.
  useEffect(() => {
    if (!editor || busy || blocked || uncertain) return undefined;
    if (editor.content === editor.baseContent && revisionRef.current === 0)
      return undefined;
    if (lastDraftTextRef.current === editor.content && revisionRef.current > 0)
      return undefined;
    const snapshot = editor;
    const timer = window.setTimeout(() => {
      if (busyRef.current || blockedRef.current || pendingGitHubRef.current)
        return;
      void persist(snapshot).catch((failure) =>
        setError(failure.message));
    }, 800);
    return () => window.clearTimeout(timer);
  }, [editor, busy, blocked, uncertain, persist]);

  async function safeToSwitch() {
    if (busyRef.current || blockedRef.current || pendingGitHubRef.current)
      return false;
    busyRef.current = true; setBusy(true);
    try {
      await queueRef.current;
      const latest = editorRef.current;
      if (latest && latest.content !== latest.baseContent &&
          (revisionRef.current < 1 ||
           lastDraftTextRef.current !== latest.content))
        await persist(latest);
      if (latest && latest.content !== latest.baseContent &&
          !window.confirm('Keep this unsynced encrypted draft for recovery and switch?'))
        return false;
      return true;
    } catch (failure) {
      block(failure.message);
      return false;
    } finally {
      busyRef.current = false; setBusy(false);
    }
  }

  async function loadKind(nextKind) {
    if (!nextKind || nextKind === kind || !await safeToSwitch()) return;
    busyRef.current = true; setBusy(true); setError('');
    try {
      const entries = typedItems(await readJson(await fetch(
        API + '?kind=' + encodeURIComponent(nextKind),
        { cache: 'no-store' },
      )), nextKind);
      const pending = await readJson(await fetch(
        DRAFT_API + '?kind=' + encodeURIComponent(nextKind) + '&new=true',
        { cache: 'no-store' },
      ));
      if (!Array.isArray(pending?.items) || pending.limited === true)
        throw new Error('Incomplete draft recovery list. Keep your browser copy.');

      setItems(entries);
      setKind(nextKind);
      applyEditor(null);
      resetDraft();
      queueRef.current = Promise.resolve();
      setStatus('Select a saved entry, or create a new one.');
      const newest = pending.items;
      if (newest.length > 0) {
        const chosen = newest.length === 1 ? 0 : Number(window.prompt(
          newest.length + ' unfinished captures found. Choose 1–' +
          newest.length + ' to recover, or Cancel to keep all pending.',
          '1',
        )) - 1;
        if (chosen >= 0 && chosen < newest.length &&
            window.confirm('Restore this encrypted unfinished capture?')) {
          const selected = newest[chosen];
          if (selected?.kind !== undefined && selected.kind !== nextKind)
            throw new TypeError('Wrong recovery type');
          if (selected?.draft?.baseSha !== null ||
              typeof selected?.draft?.content !== 'string' ||
              !Number.isSafeInteger(selected.revision) ||
              selected.revision < 1)
            throw new TypeError('Invalid encrypted draft response');
          const local = readLocal(nextKind, selected.id);
          let text = selected.draft.content;
          if (local && local.baseSha === null &&
              local.content !== text) {
            if (!window.confirm(
              'Browser and server copies differ. Press OK to keep the browser copy ' +
              'and deliberately overwrite the older server draft on the next autosave. ' +
              'Cancel to leave both copies untouched for review.',
            )) {
              setStatus('Conflicting drafts kept. Select a note after reviewing them.');
              return;
            }
            text = local.content;
          }
          applyEditor({
            kind: nextKind, id: selected.id, baseSha: null,
            baseContent: '', content: text,
          });
          resetDraft(selected.revision, selected.draft.content);
          setStatus('Unfinished encrypted draft recovered. Save explicitly to GitHub.');
        }
      } else {
        let pointer = null;
        try {
          pointer = sessionStorage.getItem(captureEditorScope(ownerId, repoId, nextKind));
        } catch { /* No local pointer. */ }
        const local = pointer && readLocal(nextKind, pointer);
        if (local && local.baseSha === null &&
            window.confirm('A browser-only unfinished capture exists. Recover it?')) {
          applyEditor({
            kind: nextKind, id: local.id, baseSha: null,
            baseContent: '', content: local.content,
          });
          resetDraft(0, null);
          setStatus('Local capture recovered. Verify encrypted autosave before GitHub Save.');
        }
      }
    } catch (failure) {
      setError(failure.message || 'Could not load standalone captures.');
    } finally {
      busyRef.current = false; setBusy(false);
    }
  }

  async function newEntry() {
    if (!kind || !await safeToSwitch()) return;
    const id = crypto.randomUUID();
    applyEditor({ kind, id, baseSha: null, baseContent: '', content: '' });
    resetDraft(0, null);
    queueRef.current = Promise.resolve();
    setStatus('New entry. Temporary encrypted autosave begins when you write.');
    setError('');
  }

  async function openEntry(entry) {
    if (!kind || !entry || !await safeToSwitch()) return;
    busyRef.current = true; setBusy(true); setError('');
    try {
      const current = await readJson(await fetch(
        API + '?kind=' + encodeURIComponent(kind) + '&id=' +
        encodeURIComponent(entry.id), { cache: 'no-store' },
      ));
      if (current?.sha !== entry.sha || current?.content !== entry.content)
        throw new Error('GitHub entry changed. Reload list before editing.');
      const response = await readJson(await fetch(
        DRAFT_API + '?kind=' + encodeURIComponent(kind) + '&id=' +
        encodeURIComponent(entry.id), { cache: 'no-store' },
      ));
      const pending = response?.item;
      const local = readLocal(kind, entry.id);
      let text = current.content;
      let nextRev = 0;
      let last = null;
      if (pending) {
        if (pending?.draft?.baseSha !== current.sha ||
            typeof pending?.draft?.content !== 'string' ||
            !Number.isSafeInteger(pending.revision) || pending.revision < 1)
          throw new Error('Encrypted draft has a different GitHub revision. Preserve and review it.');
        if (!window.confirm('An unsynced encrypted draft exists. Restore it?')) return;
        text = pending.draft.content;
        nextRev = pending.revision;
        last = pending.draft.content;
        if (local && local.baseSha === current.sha &&
            local.content !== text) {
          if (!window.confirm('Browser and encrypted drafts differ. Press OK to preserve ' +
            'the browser copy and explicitly replace the server draft on the next autosave. ' +
            'Cancel to keep both copies unchanged.')) return;
          text = local.content;
        }
      } else if (local && local.baseSha === current.sha &&
          local.content !== current.content &&
          window.confirm('Recover the browser-only unsynced copy for this entry?')) {
        text = local.content;
      }
      applyEditor({
        kind, id: entry.id, baseSha: current.sha,
        baseContent: current.content, content: text,
      });
      resetDraft(nextRev, last);
      queueRef.current = Promise.resolve();
      setStatus(nextRev ? 'Unsynced encrypted draft restored.' :
        'GitHub version loaded. Edit to create an encrypted temporary draft.');
    } catch (failure) {
      setError(failure.message || 'Could not open GitHub entry.');
    } finally { busyRef.current = false; setBusy(false); }
  }

  function changeContent(value) {
    if (busyRef.current || blockedRef.current || pendingGitHubRef.current)
      return;
    const previous = editorRef.current;
    if (!previous) return;
    const updated = { ...previous, content: value };
    applyEditor(updated);
    setError('');
  }

  async function verifyAndFinish(pending, sha) {
    const confirmation = await readJson(await fetch(DRAFT_API, {
      method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: pending.kind, id: pending.id,
        revision: pending.revision, sha,
      }),
    }));
    if (!confirmation?.confirmed || !confirmation?.cleared ||
        confirmation.sha !== sha)
      throw new Error('GitHub content may be saved, but draft cleanup is unconfirmed.');
    clearLocal(pending.kind, pending.id);
    pendingGitHubRef.current = null;
    setUncertain(false);
    resetDraft(0, null);
    const saved = {
      kind: pending.kind, id: pending.id, baseSha: sha,
      baseContent: pending.content, content: pending.content,
    };
    applyEditor(saved);
    setStatus('Current GitHub content verified. Encrypted draft revision cleared.');
    void fetch(API + '?kind=' + encodeURIComponent(pending.kind),
      { cache: 'no-store' }).then(readJson)
      .then((values) => setItems(typedItems(values, pending.kind)))
      .catch(() => setStatus('Saved and verified; refresh the list when available.'));
  }

  async function save(event) {
    event.preventDefault();
    const current = editorRef.current;
    if (!current || busyRef.current || blockedRef.current ||
        pendingGitHubRef.current) return;
    let text;
    try { text = normalizeEditorContent(current.content); }
    catch (failure) { setError(failure.message); return; }
    if (current.baseSha && current.baseContent === text &&
        revisionRef.current === 0) {
      setStatus('This entry is already committed to GitHub.');
      return;
    }
    busyRef.current = true; setBusy(true); setError('');
    try {
      await queueRef.current;
      const rev = await persist({ ...current, content: text });
      const pending = {
        kind: current.kind, id: current.id,
        baseSha: current.baseSha, content: text, revision: rev,
      };
      // The actual provider POST/PATCH may succeed even when its HTTP
      // response is lost. The page must NEVER auto replay a GitHub write.
      pendingGitHubRef.current = pending;
      setUncertain(true);
      let saved;
      try {
        saved = await readJson(await fetch(API, {
          method: current.baseSha ? 'PUT' : 'POST',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kind: current.kind, id: current.id, content: text,
            ...(current.baseSha ? { sha: current.baseSha } : {}),
          }),
        }));
      } catch {
        setError('GitHub Save outcome unknown. Do NOT retry. Use read-only Check GitHub.');
        return;
      }
      if (!currentCaptureMatchesPending(pending, saved)) {
        setError('Save response could not prove current GitHub content. Use read-only Check GitHub.');
        return;
      }
      try { await verifyAndFinish(pending, saved.sha); }
      catch {
        setError('GitHub content verified but draft cleanup uncertain. Use read-only Check GitHub.');
      }
    } catch (failure) {
      setError(failure.message || 'Encrypted draft unavailable. Keep local copy.');
    } finally { busyRef.current = false; setBusy(false); }
  }

  async function checkUnknown() {
    const pending = pendingGitHubRef.current;
    if (!pending || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError('');
    try {
      const current = await readJson(await fetch(
        API + '?kind=' + encodeURIComponent(pending.kind) +
        '&id=' + encodeURIComponent(pending.id),
        { cache: 'no-store' },
      ));
      if (!currentCaptureMatchesPending(pending, current)) {
        setError('Current GitHub content does not match this draft. No write was retried; keep recovery copy.');
        return;
      }
      await verifyAndFinish(pending, current.sha);
    } catch {
      setError('Read-only GitHub check or exact cleanup unavailable. No GitHub retry was issued.');
    } finally { busyRef.current = false; setBusy(false); }
  }

  async function reviewBlockedDraft() {
    const current = editorRef.current;
    if (!current || !blockedRef.current || busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try {
      // A fresh server read is the ONLY way to reconcile a lost PUT
      // acknowledgement. Never blindly repeat the same revision.
      const data = await readJson(await fetch(
        DRAFT_API + '?kind=' + encodeURIComponent(current.kind) +
        '&id=' + encodeURIComponent(current.id), { cache: 'no-store' },
      ));
      const remote = data?.item;
      if (!remote || remote.draft?.baseSha !== current.baseSha ||
          remote.draft?.content !== normalizeEditorContent(current.content) ||
          !Number.isSafeInteger(remote.revision) || remote.revision < 1)
        throw new Error('Server draft differs or is missing. Keep local copy for manual recovery.');
      resetDraft(remote.revision, remote.draft.content);
      queueRef.current = Promise.resolve();
      blockedRef.current = false; setBlocked(false);
      setError('');
      setStatus('Exact encrypted server draft recovered; editing may resume.');
    } catch (failure) {
      setError(failure.message || 'Encrypted draft outcome still uncertain.');
    } finally { busyRef.current = false; setBusy(false); }
  }

  async function copyContent() {
    try {
      await navigator.clipboard.writeText(editorRef.current?.content || '');
      setStatus('Visible editor content copied. Store it somewhere private.');
    } catch { setError('Copy failed. Select and copy the visible text manually.'); }
  }

  return (
    <section className="oge-settings-card" aria-labelledby="standalone-vault-heading">
      <div className="oge-settings-card-heading">
        <div>
          <span className="oge-section-kicker">E4 · STAGING-ONLY PREVIEW</span>
          <h2 id="standalone-vault-heading">Private standalone captures</h2>
        </div>
        <span className="oge-settings-pill">GitHub on explicit Save</span>
      </div>
      <p className="oge-settings-description">
        Quick Notes and AirNotes are separate GitHub Vault resources.
        Autosave stores only temporary encrypted MongoDB drafts; pressing
        Save is the only action that commits to private GitHub.
      </p>
      <div className="oge-note-editor-actions">
        <button type="button" className="oge-primary-link"
          disabled={busy || blocked || uncertain}
          onClick={() => { void loadKind('quick-notes'); }}>
          Quick Notes
        </button>
        <button type="button" className="oge-primary-link"
          disabled={busy || blocked || uncertain}
          onClick={() => { void loadKind('airnotes'); }}>
          AirNotes
        </button>
      </div>
      {kind && <>
        <p className="oge-settings-note">Selected: {kind === 'airnotes' ?
          'AirNotes' : 'Quick Notes'}. Up to 300 committed entries are listed.</p>
        <div className="oge-note-editor-actions">
          <button type="button" className="oge-primary-link"
            onClick={() => { void newEntry(); }}
            disabled={busy || blocked || uncertain}>New capture</button>
          <button type="button" className="oge-signin"
            onClick={() => { void loadKind(kind === 'airnotes' ?
              'quick-notes' : 'airnotes'); }}
            disabled={busy || blocked || uncertain}>Switch type</button>
        </div>
        <div className="oge-subject-list">
          {items.map((item) => <button type="button" key={item.id}
            className={editor?.id === item.id ? 'oge-subject is-active' : 'oge-subject'}
            disabled={busy || blocked || uncertain}
            onClick={() => { void openEntry(item); }}>
            {item.title || 'New note'}
          </button>)}
        </div>
      </>}
      {editor && <>
        <form className="oge-note-editor-form" onSubmit={save}>
          <label htmlFor="standalone-vault-body">
            {editor.kind === 'airnotes' ? 'AirNote' : 'Quick Note'} ·
            {editor.baseSha ? ' GitHub revision' : ' New capture'}
          </label>
          <textarea id="standalone-vault-body" className="oge-note-answer-input"
            value={editor.content} rows={12} maxLength={20000}
            onChange={(event) => changeContent(event.target.value)}
            disabled={busy || blocked || uncertain}
            placeholder="First line becomes the title. Write freely…"/>
          <div className="oge-note-editor-actions">
            <span>{editor.content.length}/20,000 characters ·
              Encrypted draft revision {revision}</span>
            <button type="submit" className="oge-primary-link"
              disabled={busy || blocked || uncertain}>
              {busy ? 'Checking…' : 'Save to GitHub'}
            </button>
          </div>
        </form>
        <button type="button" className="oge-signin"
          onClick={() => { void copyContent(); }}>Copy visible note text</button>
      </>}
      {uncertain && <button type="button" className="oge-primary-link"
        disabled={busy} onClick={() => { void checkUnknown(); }}>
        Check GitHub Save (read-only; no retry)
      </button>}
      {blocked && <button type="button" className="oge-primary-link"
        disabled={busy} onClick={() => { void reviewBlockedDraft(); }}>
        Re-read exact encrypted draft (no retry)
      </button>}
      <p className="oge-settings-note" role="status">{status}</p>
      {error && <p className="oge-form-error" role="alert">{error}</p>}
      <p className="oge-settings-note">This preview never deletes GitHub files,
        never calls legacy MongoDB note APIs, never retries an uncertain
        GitHub write and never grants extension tokens access to the Vault.
        Browser session copies are temporary and may be lost.</p>
      <Link href="/vault" className="oge-signin">Return to Vault →</Link>
    </section>
  );
}
