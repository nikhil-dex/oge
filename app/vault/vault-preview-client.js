'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  createVaultAutosave, readVaultDraft, vaultDraftKey,
} from '../../lib/oge-vault-autosave.js';

async function responseJson(response) {
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(value.error || 'GitHub could not complete the request.');
    error.status = response.status;
    throw error;
  }
  return value;
}

const STATUS = {
  new: 'New note — not yet on GitHub',
  incomplete: 'Incomplete draft — not synced',
  synced: 'Synced to GitHub',
  pending: 'Unsaved changes in this tab',
  saving: 'Saving to GitHub…',
  offline: 'Offline — unsaved draft kept in this tab',
  retrying: 'GitHub unavailable — retry scheduled',
  recovered: 'Recovered unsaved draft — review and retry',
  conflict: 'Conflict — choose which copy to keep',
  error: 'Save unconfirmed — retry manually',
  'storage-error': 'Local draft storage unavailable — do not close this tab',
};

function clientTransport() {
  return {
    batch: async (operations) => responseJson(await fetch('/api/vault/batch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      cache: 'no-store', body: JSON.stringify({ operations }),
    })),
    read: async (id) => responseJson(await fetch('/api/vault/notes?id=' + encodeURIComponent(id), {
      cache: 'no-store',
    })),
  };
}

export default function VaultPreviewClient({ ownerId, repoId }) {
  const [subjects, setSubjects] = useState([]);
  const [notes, setNotes] = useState([]);
  const [active, setActive] = useState(null);
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState('');
  const [creatingSubject, setCreatingSubject] = useState(false);
  const [subjectName, setSubjectName] = useState('');
  const [online, setOnline] = useState(true);
  const controller = useRef(null);
  const transport = useRef(null);
  const activeKey = 'oge-vault-preview-active:' + encodeURIComponent(ownerId) + ':' + repoId;

  useEffect(() => {
    transport.current = clientTransport();
    const onOnline = () => { setOnline(true); controller.current?.retryNow(); };
    const onOffline = () => setOnline(false);
    Promise.resolve().then(() => setOnline(navigator.onLine));
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      controller.current?.stop();
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  const openNote = useCallback((note) => {
    if (!note?.id || !note?.subjectId) return;
    controller.current?.stop();
    const key = vaultDraftKey(ownerId, repoId, note.id);
    const state = createVaultAutosave({
      storage: window.sessionStorage, key, initial: {
        id: note.id, subjectId: note.subjectId,
        heading: note.heading || '', answer: note.answer || '',
        tags: Array.isArray(note.tags) ? note.tags : [],
        favorite: note.favorite === true, sha: note.sha ?? null,
      },
      ...transport.current,
      isOnline: () => navigator.onLine,
      onState: (next) => setSnapshot(next),
    });
    controller.current = state;
    window.sessionStorage.setItem(activeKey, note.id);
    setActive(note.id);
    const restored = state.restore();
    setSnapshot(restored);
    if (restored.status === 'recovered' && navigator.onLine) {
      // Never auto-overwrite the server on reload; user must review the
      // recovered draft and explicitly retry synchronization.
    }
  }, [activeKey, ownerId, repoId]);

  const load = useCallback(async () => {
    setLoading(true);
    setPageError('');
    try {
      const [subjectOutcome, notesOutcome] = await Promise.allSettled([
        responseJson(await fetch('/api/subjects', { cache: 'no-store' })),
        responseJson(await fetch('/api/vault/notes', { cache: 'no-store' })),
      ]);
      const subjectList = subjectOutcome.status === 'fulfilled' ? subjectOutcome.value : [];
      const noteList = notesOutcome.status === 'fulfilled' ? notesOutcome.value : [];
      setSubjects(subjectList);
      setNotes(noteList);
      if (subjectOutcome.status === 'rejected' || notesOutcome.status === 'rejected') {
        setPageError('Could not reach all storage services. Any locally recoverable draft from this tab is shown below; it has not been confirmed on GitHub.');
      }
      const existingId = window.sessionStorage.getItem(activeKey);
      const existing = noteList.find((item) => item.id === existingId);
      if (existing) openNote(existing);
      else if (existingId) {
        // A created-but-not-yet-synced draft must survive a page reload even
        // though GitHub has no corresponding note yet.
        try {
          const key = vaultDraftKey(ownerId, repoId, existingId);
          const draft = readVaultDraft(window.sessionStorage, key);
          if (draft) openNote(draft);
          else window.sessionStorage.removeItem(activeKey);
        } catch {
          window.sessionStorage.removeItem(activeKey);
        }
      }
    } catch (error) {
      setPageError(error.message || 'Could not load GitHub notes.');
    } finally {
      setLoading(false);
    }
  }, [openNote, ownerId, repoId, activeKey]);

  useEffect(() => { Promise.resolve().then(() => void load()); }, [load]);

  const busy = Boolean(snapshot && snapshot.status !== 'synced');
  function newNote() {
    if (!subjects.length || busy) return;
    const id = crypto.randomUUID();
    // A new blank note is held in memory until the first valid edit.
    openNote({ id, subjectId: subjects[0].slug, heading: '', answer: '',
      tags: [], favorite: false, sha: null });
  }
  function update(patch) {
    try {
      controller.current?.edit(patch);
    } catch (error) {
      setPageError(error.message);
    }
  }
  function trySave() {
    const draft = controller.current?.getState().draft;
    if (!draft?.heading.trim() || !draft?.answer.trim()) {
      setPageError('Enter a title and note content before syncing to GitHub.');
      return;
    }
    setPageError('');
    controller.current?.retryNow();
  }
  function discardUnsyncedDraft() {
    if (!draft || !window.confirm('Discard unsynced changes in this tab? This cannot be undone.')) return;
    controller.current?.stop();
    try {
      window.sessionStorage.removeItem(vaultDraftKey(ownerId, repoId, draft.id));
      window.sessionStorage.removeItem(activeKey);
    } catch {
      setPageError('Browser storage could not be cleared. Do not share this device.');
      return;
    }
    setActive(null);
    setSnapshot(null);
    void load();
  }
  async function createSubject(event) {
    event.preventDefault();
    if (creatingSubject || !subjectName.trim()) return;
    setCreatingSubject(true);
    try {
      const subject = await responseJson(await fetch('/api/subjects', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: subjectName }),
      }));
      setSubjects((list) => [...list, subject]);
      setSubjectName('');
      setPageError('');
    } catch (error) {
      setPageError(error.message);
    } finally {
      setCreatingSubject(false);
    }
  }

  const draft = snapshot?.draft;
  const labels = STATUS[snapshot?.status] || 'Ready';
  return (
    <div className="oge-vault-preview-layout">
      <section className="oge-settings-card oge-vault-preview-sidebar" aria-label="GitHub notes">
        <div className="oge-settings-card-heading">
          <div><span className="oge-section-kicker">01 · REPOSITORY</span><h2>Vault notes</h2></div>
        </div>
        <button className="oge-google-button" type="button" onClick={newNote}
          disabled={loading || !subjects.length || busy}>+ New GitHub note</button>
        <p className="oge-settings-note">Changing notes is disabled while a draft is unsynced. GitHub is the only persistent note store in this preview.</p>
        <div className="oge-vault-preview-list">
          {notes.map((note) => (
            <button key={note.id} type="button" disabled={busy}
              aria-current={active === note.id ? 'true' : undefined}
              onClick={() => openNote(note)}>
              <strong>{note.heading}</strong>
              <span>{note.updatedAt ? new Date(note.updatedAt).toLocaleDateString() : 'GitHub note'}</span>
            </button>
          ))}
        </div>
        {!notes.length && <p className="oge-settings-note">No notes found in this private vault yet.</p>}
        <form onSubmit={createSubject} className="oge-vault-subject-form">
          <label htmlFor="vault-preview-subject-new">New subject (metadata in MongoDB)</label>
          <input id="vault-preview-subject-new" maxLength={60} value={subjectName}
            onChange={(event) => setSubjectName(event.target.value)} placeholder="e.g. Computer Networks"/>
          <button type="submit" disabled={creatingSubject || !subjectName.trim()}>Create subject</button>
        </form>
      </section>
      <section className="oge-settings-card oge-vault-preview-editor" aria-label="GitHub note editor">
        <div className="oge-settings-card-heading">
          <div><span className="oge-section-kicker">02 · EDITOR</span><h2>Private notes</h2></div>
          <span className="oge-settings-pill">{online ? 'Online' : 'Offline'}</span>
        </div>
        {loading ? <p role="status">Loading GitHub notes…</p> :
          draft ? <>
            <div className="oge-vault-preview-status" role="status" aria-live="polite">
              <strong>{labels}</strong>
              {snapshot?.lastError && <span>{snapshot.lastError}</span>}
            </div>
            <label htmlFor="vault-preview-subject">Subject</label>
            <select id="vault-preview-subject" value={draft.subjectId} disabled={draft.sha !== null}
              onChange={(event) => update({ subjectId: event.target.value })}>
              {subjects.map((subject) => <option key={subject.slug} value={subject.slug}>{subject.name}</option>)}
            </select>
            <label htmlFor="vault-preview-title">Title</label>
            <input id="vault-preview-title" value={draft.heading} maxLength={160}
              onChange={(event) => update({ heading: event.target.value })}/>
            <label htmlFor="vault-preview-body">Note content</label>
            <textarea id="vault-preview-body" value={draft.answer} rows={11}
              onChange={(event) => update({ answer: event.target.value })}/>
            <div className="oge-vault-preview-actions">
              <button type="button" className="oge-google-button" onClick={trySave}
                disabled={!online || snapshot?.status === 'saving' || snapshot?.status === 'conflict'}>Sync now / Retry</button>
              <button type="button" onClick={() => void load()} disabled={busy}>Reload GitHub notes</button>
              {busy && <button type="button" onClick={discardUnsyncedDraft}
                disabled={snapshot?.status === 'saving'}>Discard local draft</button>}
            </div>
            {snapshot?.status === 'conflict' && (
              <div role="alert" className="oge-vault-preview-conflict">
                <strong>Another GitHub version conflicts with this draft.</strong>
                <p>Your local draft is preserved in this tab. Copy it before choosing the remote version.</p>
                {snapshot.conflict?.remote
                  ? <button type="button" onClick={() => controller.current?.discardConflict()}>Discard local draft and use GitHub version</button>
                  : <p>The note was removed on GitHub. Copy your local text, then discard this draft and create a new note.</p>}
              </div>
            )}
          </> : <p className="oge-settings-description">Select a GitHub note or create one above. Existing MongoDB Notes are not shown here.</p>}
        {pageError && <p role="alert" className="oge-password-error">{pageError}</p>}
        <p className="oge-settings-note">Experimental preview. Unsynced drafts are kept in this tab&apos;s session storage for up to 24 hours; this is not a backup. Use the Sync button to confirm GitHub storage before leaving.</p>
        <Link href="/vault" className="oge-primary-link">← Back to Oge Vault</Link>
      </section>
    </div>
  );
}
