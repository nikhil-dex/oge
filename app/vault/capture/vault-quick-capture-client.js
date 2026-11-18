'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  VAULT_CAPTURE_MAX_CHARS, vaultCaptureFields, vaultCaptureLocalKey,
  vaultCapturePointer, vaultCaptureRecoveryText, resolveBrowserOnlyCapture,
} from '../../../lib/oge-vault-quick-capture.js';
import { recentVaultNotesKey, rememberRecentVaultNote } from '../../../lib/oge-vault-recent-notes.js';

async function responseJson(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error || 'Request not confirmed.');
  return body;
}

/**
 * E1: owner-browser short capture to encrypted temporary Vault drafts.
 * GitHub is touched only by the explicit Save button, through the existing
 * signed, create-only, verified Notes batch API. Never silently replays an
 * uncertain GitHub Save or discards either browser/server draft on conflict.
 */
export default function VaultQuickCaptureClient({ ownerId, repoId }) {
  const [subjects, setSubjects] = useState([]);
  const [newSubjectName, setNewSubjectName] = useState('');
  const [creatingSubject, setCreatingSubject] = useState(false);
  const [subjectId, setSubjectId] = useState('');
  const [content, setContent] = useState('');
  const [noteId, setNoteId] = useState('');
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState('Select a subject to begin.');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const queueRef = useRef(Promise.resolve());
  const revisionRef = useRef(0);
  const savedSnapshotRef = useRef('');
  const blockedRef = useRef(false);
  const uncertainRef = useRef(false);
  const busyRef = useRef(false);
  const generationRef = useRef(0);

  const preserveLocal = useCallback((id, subject, text) => {
    if (!id || !subject || !text.trim()) return;
    try {
      sessionStorage.setItem(vaultCapturePointer(ownerId, repoId, subject), id);
      sessionStorage.setItem(vaultCaptureLocalKey(ownerId, repoId, id), text);
    } catch { /* Session storage may be denied; keep the editor copy intact. */ }
  }, [ownerId, repoId]);

  useEffect(() => {
    fetch('/api/subjects', { cache: 'no-store' })
      .then(responseJson)
      .then((items) => {
        if (!Array.isArray(items)) throw new TypeError('Invalid subjects');
        setSubjects(items.filter((item) =>
          typeof item?.slug === 'string' && typeof item?.name === 'string'));
        setLoaded(true);
      })
      .catch(() => { setError('Could not load subjects. Open Vault Notes to check your connection.'); setLoaded(true); });
  }, []);

  useEffect(() => {
    preserveLocal(noteId, subjectId, content);
  }, [noteId, subjectId, content, preserveLocal]);

  const choose = useCallback(async (selected) => {
    if (busyRef.current || uncertainRef.current) return;
    busyRef.current = true; setBusy(true);
    // Finish any in-flight encrypted draft CAS before switching note scope.
    // A lost autosave acknowledgement must never reset its unknown revision.
    try { await queueRef.current; }
    catch {
      setError('Previous encrypted draft write is uncertain. Recover it in Vault Notes first.');
      busyRef.current = false; setBusy(false); return;
    }
    if (blockedRef.current) {
      setError('Resolve the previous draft conflict before changing subjects.');
      busyRef.current = false; setBusy(false); return;
    }
    if (content && !window.confirm('Keep this capture for recovery and switch subjects?')) {
      busyRef.current = false; setBusy(false); return;
    }
    const generation = ++generationRef.current;
    setError('');
    setBlocked(false); blockedRef.current = false;
    setUncertain(false); uncertainRef.current = false;
    setSubjectId(selected);
    setNoteId('');
    setContent('');
    revisionRef.current = 0;
    setRevision(0);
    savedSnapshotRef.current = '';
    if (!selected) {
      setStatus('Select a subject to begin.');
      busyRef.current = false; setBusy(false); return;
    }
    try {
      const data = await responseJson(await fetch(
        '/api/vault/drafts?new=true&subject=' + encodeURIComponent(selected),
        { cache: 'no-store' }));
      if (generation !== generationRef.current) return;
      const candidates = Array.isArray(data.items) ? data.items : [];
      if (data.limited) {
        setError('More drafts may exist; use the full Vault Notes editor for recovery.');
        return;
      }
      let pointer = null;
      try { pointer = sessionStorage.getItem(vaultCapturePointer(ownerId, repoId, selected)); }
      catch { /* private browser storage may be disabled */ }
      const matching = candidates.filter((x) => x?.draft?.subjectId === selected &&
        x.draft.baseSha === null && typeof x.id === 'string');
      const preferred = matching.find((x) => x.id === pointer);
      const candidate = preferred || (matching.length === 1 ? matching[0] : null);
      if (matching.length > 1 && !preferred) {
        setError('Several unfinished drafts exist. Review them in Vault Notes; none were overwritten.');
        return;
      }
      if (candidate && window.confirm('Recover your unfinished Vault capture in this subject?')) {
        let local = null;
        try { local = sessionStorage.getItem(vaultCaptureLocalKey(ownerId, repoId, candidate.id)); }
        catch { /* harmless */ }
        const recovered = vaultCaptureRecoveryText(candidate.draft, local);
        // Equal heading+body means the user's exact local formatting is
        // already acknowledged by the temporary server draft. Restoring it
        // must not invent a duplicate first line or trigger another autosave.
        const selectedText = recovered.matchesBrowserCopy ? recovered.text
          : local !== null && local !== recovered.serverText &&
            window.confirm('Your browser copy differs from the encrypted server draft. Restore the browser copy?')
            ? local : recovered.serverText;
        setNoteId(candidate.id); setContent(selectedText);
        revisionRef.current = candidate.revision;
        setRevision(candidate.revision);
        savedSnapshotRef.current = recovered.matchesBrowserCopy
          ? recovered.text : recovered.serverText;
        setStatus('Recovered temporary draft. Review before GitHub Save.');
      } else if (pointer && !candidate) {
        let local = null;
        try { local = sessionStorage.getItem(vaultCaptureLocalKey(ownerId, repoId, pointer)); }
        catch { /* harmless */ }
        if (local !== null && window.confirm('No server draft found. Recover your browser-only note?')) {
          // A browser pointer can outlive a successfully committed Note.
          // Check that one UUID before offering a new Save, so an old copy
          // cannot silently become a duplicate Note after lost cleanup.
          let saved = null;
          let verifiedMissing = false;
          try {
            const response = await fetch('/api/vault/notes-main?id=' + encodeURIComponent(pointer),
              { cache: 'no-store' });
            if (response.status === 404) verifiedMissing = true;
            else if (response.ok) saved = await response.json();
          } catch { /* GitHub may be offline; never discard the local copy. */ }
          if (generation !== generationRef.current) return;
          const recovery = resolveBrowserOnlyCapture({
            pointer, subjectId: selected, text: local, saved,
            verifiedMissing, newId: crypto.randomUUID(),
          });
          if (recovery.alreadySaved) {
            // Only an exact confirmed GitHub Note is enough to clear the
            // duplicate browser copy. The actual Note stays on GitHub.
            try {
              sessionStorage.removeItem(vaultCapturePointer(ownerId, repoId, selected));
              sessionStorage.removeItem(vaultCaptureLocalKey(ownerId, repoId, pointer));
            } catch { /* Local cleanup is best effort. */ }
            setNoteId(recovery.noteId);
            setStatus('This note was already saved to GitHub. Find it in All GitHub Notes.');
          } else {
            setNoteId(recovery.noteId);
            setContent(recovery.text);
            setStatus(saved
              ? 'Recovered newer browser text as a new Note. Your earlier GitHub Note is unchanged.'
              : recovery.reuseId
                ? 'Recovered browser text. You can keep writing and press Save.'
                : 'Recovered browser text. Check GitHub Notes for a previous Save before committing.');
          }
        } else {
          // Empty or dismissed local recovery: prepare a separate new note.
          // Keep any declined browser copy untouched for later recovery.
          setNoteId(crypto.randomUUID());
          setStatus('Ready to write. A single thought works, or write a title and body.');
        }
      } else {
        // A fresh subject with no pending draft should be writable immediately.
        setNoteId(crypto.randomUUID());
        setStatus('Ready to write. A single thought works, or write a title and body.');
      }
    } catch {
      if (generation === generationRef.current) {
        setError('Server draft recovery unavailable. No existing draft was overwritten.');
        setStatus('Open Vault Notes to recover drafts before starting.');
        setBlocked(true); blockedRef.current = true;
      }
    } finally {
      if (generation === generationRef.current) {
        setBusy(false); busyRef.current = false;
      }
    }
  }, [ownerId, repoId, content]);

  // A connected student with just one subject can start writing immediately.
  // Let the ordinary recovery path run, so existing unfinished drafts still
  // get their usual recovery prompt before a fresh capture is allocated.
  useEffect(() => {
    if (!loaded || subjects.length !== 1 || subjectId || noteId ||
        busyRef.current || blockedRef.current || uncertainRef.current) return;
    Promise.resolve().then(() => {
      if (!busyRef.current && !blockedRef.current && !uncertainRef.current)
        void choose(subjects[0].slug);
    });
  }, [loaded, subjects, subjectId, noteId, choose]);

  async function createSubject(event) {
    event.preventDefault();
    const name = newSubjectName.trim();
    if (!name || creatingSubject || busyRef.current || uncertainRef.current) return;
    setCreatingSubject(true);
    setError('');
    try {
      const created = await responseJson(await fetch('/api/subjects', {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }));
      if (!created?.slug || !created?.name)
        throw new Error('Subject was not returned after creation.');
      setSubjects((current) => [...current, created]);
      setNewSubjectName('');
      await choose(created.slug);
    } catch (err) {
      setError(err.message || 'Could not add subject.');
    } finally {
      setCreatingSubject(false);
    }
  }

  const newCapture = async () => {
    if (!subjectId || busyRef.current || blockedRef.current || uncertainRef.current) return;
    busyRef.current = true; setBusy(true);
    try { await queueRef.current; }
    catch {
      setError('Previous encrypted draft write is uncertain. Recover it in Vault Notes first.');
      busyRef.current = false; setBusy(false); return;
    }
    if (content && !window.confirm('Keep your previous capture in server/browser recovery and start a different one?')) {
      busyRef.current = false; setBusy(false); return;
    }
    const id = crypto.randomUUID();
    setNoteId(id);
    setContent('');
    revisionRef.current = 0; setRevision(0);
    savedSnapshotRef.current = '';
    setError('');
    setStatus('Ready to write. A single thought works, or write a title and body.');
    blockedRef.current = false; setBlocked(false);
    uncertainRef.current = false; setUncertain(false);
    busyRef.current = false; setBusy(false);
  };

  const persist = useCallback(async (id, subject, text) => {
    if (blockedRef.current || uncertainRef.current)
      throw new Error('Previous result uncertain. Review or recover; no automatic replay.');
    const draft = vaultCaptureFields(text, subject);
    const op = queueRef.current.catch(() => {}).then(async () => {
      if (blockedRef.current || uncertainRef.current)
        throw new Error('A previous operation must be reviewed.');
      if (savedSnapshotRef.current === text) return revisionRef.current;
      const next = revisionRef.current + 1;
      const result = await responseJson(await fetch('/api/vault/drafts', {
        method: 'PUT', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, revision: next, draft }),
      }));
      if (result?.revision !== next || result?.savedTo !== 'temporary-draft')
        throw new Error('Encrypted autosave acknowledgement invalid.');
      revisionRef.current = next;
      savedSnapshotRef.current = text;
      setRevision(next);
      setStatus('Encrypted temporary draft saved. Not yet committed to GitHub.');
      return next;
    });
    queueRef.current = op;
    try { return await op; }
    catch {
      blockedRef.current = true; setBlocked(true);
      setStatus('Draft Save response missing or conflicted. No automatic retry.');
      throw new Error('Draft outcome is uncertain. Recover it in Vault Notes.');
    }
  }, []);

  // Autosave only complete captures, sequentially, with a 900 ms debounce.
  // Never resubmit a CAS revision after an ambiguous response.
  useEffect(() => {
    if (!noteId || !subjectId || busy || blocked || uncertain) return undefined;
    try { vaultCaptureFields(content, subjectId); }
    catch { return undefined; }
    if (savedSnapshotRef.current === content) return undefined;
    const timer = window.setTimeout(() => {
      // Subject switching or explicit Save may have begun while this
      // timeout was waiting. Only the explicit Save may flush during busy.
      if (busyRef.current) return;
      void persist(noteId, subjectId, content).catch((e) =>
        setError(e.message));
    }, 900);
    return () => window.clearTimeout(timer);
  }, [content, noteId, subjectId, busy, blocked, uncertain, persist]);

  async function reconcile(id, rev, sha) {
    const result = await responseJson(await fetch('/api/vault/drafts', {
      method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, revision: rev, sha }),
    }));
    if (result.confirmed !== true || result.cleared !== true)
      throw new Error('GitHub Save verified but draft reconciliation remains pending.');
    return result;
  }

  function clearSaved(id, subject) {
    try {
      sessionStorage.removeItem(vaultCaptureLocalKey(ownerId, repoId, id));
      if (sessionStorage.getItem(vaultCapturePointer(ownerId, repoId, subject)) === id)
        sessionStorage.removeItem(vaultCapturePointer(ownerId, repoId, subject));
    } catch { /* success was verified remotely; local cleanup is best effort */ }
    // Keep the same subject selected and prepare an empty new note.
    // No GitHub commit or MongoDB draft is created until the user writes.
    setNoteId(crypto.randomUUID()); setContent(''); setRevision(0);
    revisionRef.current = 0; savedSnapshotRef.current = '';
    setBlocked(false); blockedRef.current = false;
    setUncertain(false); uncertainRef.current = false;
    setStatus('Saved to GitHub. Ready for your next note in this subject.');
  }

  async function commit(event) {
    event.preventDefault();
    if (!noteId || !subjectId || busyRef.current || blockedRef.current ||
        uncertainRef.current) return;
    let fields;
    try { fields = vaultCaptureFields(content, subjectId); }
    catch (e) { setError(e.message); return; }
    busyRef.current = true; setBusy(true); setError('');
    try {
      await queueRef.current;
      const rev = await persist(noteId, subjectId, content);
      // Once submitted GitHub may have committed even if HTTP fails.
      uncertainRef.current = true; setUncertain(true);
      let saved;
      try {
        saved = await responseJson(await fetch('/api/vault/notes-main', {
          method: 'POST', cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: noteId, subjectSlug: subjectId, heading: fields.heading,
            answer: fields.answer, tags: [],
          }),
        }));
      } catch {
        setError('GitHub Save outcome unknown. Do not press Save again. Use Check GitHub Save.');
        return;
      }
      if (saved?.id !== noteId || !/^[a-f0-9]{40}$/i.test(saved?.sha || '')) {
        setError('Unverified GitHub Save response. Use read-only recovery.');
        return;
      }
      // Remember only the committed UUID, never a Note body, so the full
      // Notes page can show this capture even beyond its first UUID page.
      try {
        rememberRecentVaultNote(window.localStorage,
          recentVaultNotesKey(ownerId, repoId), saved.id);
      } catch { /* The GitHub Save is confirmed even without local storage. */ }
      try {
        await reconcile(noteId, rev, saved.sha);
        clearSaved(noteId, subjectId);
      } catch {
        setStatus('GitHub Save confirmed, but encrypted draft cleanup is pending.');
        setError('Use Check GitHub Save to reconcile without another write.');
      }
    } catch (e) {
      setError(e.message || 'Temporary draft unavailable. Keep your browser copy.');
    } finally { busyRef.current = false; setBusy(false); }
  }

  async function checkUnknown() {
    if (!uncertainRef.current || !noteId || !revisionRef.current ||
        busyRef.current) return;
    busyRef.current = true; setBusy(true); setError('');
    try {
      const data = await responseJson(await fetch(
        '/api/vault/drafts?id=' + encodeURIComponent(noteId) +
        '&confirm=true&revision=' + revisionRef.current,
        { cache: 'no-store' },
      ));
      if (data?.confirmed !== true || !/^[a-f0-9]{40}$/i.test(data.sha || '')) {
        setError('GitHub Save not proven. No retry was performed. Keep this draft for operator review.');
        return;
      }
      await reconcile(noteId, revisionRef.current, data.sha);
      try {
        rememberRecentVaultNote(window.localStorage,
          recentVaultNotesKey(ownerId, repoId), noteId);
      } catch { /* Optional browser navigation hint. */ }
      clearSaved(noteId, subjectId);
    } catch {
      setError('Read-only GitHub verification or cleanup unavailable. Keep the draft; no GitHub retry occurred.');
    } finally { busyRef.current = false; setBusy(false); }
  }

  return (
    <section className="oge-settings-card" aria-labelledby="vault-capture-title">
      <div className="oge-settings-card-heading">
        <div><span className="oge-section-kicker">WRITE A NOTE</span>
          <h2 id="vault-capture-title">Quick Capture → Vault</h2></div>
        <span className="oge-settings-pill">Private GitHub on Save</span>
      </div>
      <p className="oge-settings-description">
        Choose a subject and write a quick thought. For a longer note, put a title
        on the first line and the details below. Your draft autosaves temporarily;
        press Save to commit the finished Note to your private GitHub Vault.
      </p>
      <form onSubmit={createSubject} className="oge-note-editor-actions">
        <label htmlFor="vault-capture-new-subject">New subject</label>
        <input id="vault-capture-new-subject" value={newSubjectName}
          maxLength={60} placeholder="e.g. Machine Learning"
          onChange={(event) => setNewSubjectName(event.target.value)}
          disabled={busy || uncertain || creatingSubject} />
        <button type="submit" className="oge-primary-link"
          disabled={busy || uncertain || creatingSubject || !newSubjectName.trim()}>
          {creatingSubject ? 'Adding…' : 'Add subject'}
        </button>
      </form>
      {loaded && subjects.length === 0 && !error &&
        <p role="status">Start by adding a subject above. Then write your first note.</p>}
      <label htmlFor="vault-capture-subject">Subject</label>
      <select id="vault-capture-subject" value={subjectId}
        onChange={(event) => { void choose(event.target.value); }}
        disabled={busy || uncertain || !loaded}>
        <option value="">Choose subject</option>
        {subjects.map((s) => <option key={s.slug} value={s.slug}>{s.name}</option>)}
      </select>
      {subjectId && <div className="oge-note-editor-actions">
        <button type="button" className="oge-primary-link" disabled={busy || uncertain}
          onClick={() => { void newCapture(); }}>New capture</button>
        <span>Encrypted draft revision: {revision}</span>
      </div>}
      <form onSubmit={commit} className="oge-note-editor-form">
        <label htmlFor="vault-capture-content">Quick note</label>
        <textarea id="vault-capture-content" className="oge-note-answer-input"
          rows={11} value={content} maxLength={VAULT_CAPTURE_MAX_CHARS}
          placeholder={'Title on first line\n\nWrite your note here…'}
          onChange={(event) => {
            setContent(event.target.value);
            setError('');
          }} disabled={!noteId || busy || uncertain || blocked}
        />
        <div className="oge-note-editor-actions">
          <span>{content.length} / {VAULT_CAPTURE_MAX_CHARS}</span>
          <button type="submit" className="oge-primary-link"
            disabled={!noteId || busy || uncertain || blocked || !content.trim()}>
            {busy ? 'Checking…' : 'Save to GitHub →'}
          </button>
        </div>
      </form>
      {uncertain && <button type="button" className="oge-primary-link"
        onClick={() => { void checkUnknown(); }} disabled={busy}>
        Check GitHub Save (read-only)
      </button>}
      <p className="oge-settings-note" role="status">{status}</p>
      {error && <p className="oge-form-error" role="alert">{error}</p>}
      {blocked && <p className="oge-settings-note" role="alert">
        The draft state is uncertain. No automatic retry is permitted.
        Keep this browser copy and use the full <Link href="/vault/notes">Vault Notes
        recovery workspace</Link> before making more changes.
      </p>}
      <p className="oge-settings-note">No automatic GitHub pushes, no permanent
        MongoDB Note bodies, and no silent replay of an uncertain Save.
        GitHub history still retains committed versions.</p>
      <Link href="/vault/notes" className="oge-signin">Open full Vault Notes →</Link>
    </section>
  );
}
