'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import SiteNavbar from './site-navbar';

async function readResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
  return data;
}
function titleOf(content) {
  return String(content || '').split('\n', 1)[0].trim() || 'Untitled note';
}
function formatDate(value) {
  if (!value) return 'Just created';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Recently edited';
  return date.toLocaleString('en-IN', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}
function QuickNoteCard({ note, index, onDelete }) {
  const [copied, setCopied] = useState(false);
  const content = note.content || '';
  async function copyNote() {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
    } catch { setCopied(false); }
  }
  return (
    <article className="quick-note-section">
      <div className="quick-note-topline">
        <span className="quick-note-index">{String(index + 1).padStart(2, '0')}</span>
        <span className="quick-note-date">{formatDate(note.updatedAt || note.createdAt)}</span>
        <button className="quick-note-copy" type="button" onClick={copyNote}
          aria-label={'Copy ' + titleOf(content)}>{copied ? 'Copied!' : 'Copy'}</button>
        <button className="quick-note-delete" type="button" onClick={() => onDelete(note)}
          aria-label={'Delete ' + titleOf(content)} title="Delete Quick Note">×</button>
      </div>
      <div className="quick-note-editor" role="article"
        aria-label={'Quick note ' + (index + 1)}>{content}</div>
      <div className="quick-note-bottomline">
        <span>{content.length} characters</span><span>Saved</span>
      </div>
    </article>
  );
}

/**
 * Home Quick Notes is an extension inbox, not a new-note editor.
 * Existing captures remain readable and deletable in either storage mode.
 */
export default function QuickNotesPanel({
  fullPage = false, apiPath = '/api/quick-notes',
}) {
  const vaultBacked = apiPath === '/api/vault/quick-notes';
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const loadNotes = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await readResponse(await fetch(apiPath, { cache: 'no-store' }));
      setNotes(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err.message || 'Could not load Quick Notes.');
    } finally {
      setLoading(false);
    }
  }, [apiPath]);
  useEffect(() => { void loadNotes(); }, [loadNotes]);

  async function deleteNote(note) {
    if (!window.confirm('Delete "' + titleOf(note.content) + '"? This cannot be undone.')) return;
    setError('');
    setMessage('');
    try {
      await readResponse(await fetch(apiPath + '?id=' + encodeURIComponent(note.id) +
        (vaultBacked ? '&sha=' + encodeURIComponent(note.sha || '') : ''),
      { method: 'DELETE' }));
      setNotes(current => current.filter(item => item.id !== note.id));
      setMessage('Quick Note deleted.');
    } catch (err) {
      setError(err.message || 'Could not delete this Quick Note.');
    }
  }
  const visibleNotes = fullPage ? notes : notes.slice(0, 3);

  return (
    <section className={'quick-notes-section' + (fullPage ? ' quick-notes-full-page' : '')}
      aria-labelledby="quick-notes-heading">
      {fullPage && <SiteNavbar />}
      <div className="quick-notes-heading-row">
        <div>
          <p className="eyebrow">{fullPage ? 'CAPTURE IT BEFORE YOU FORGET' : 'THOUGHTS, REMINDERS & IDEAS'}</p>
          <h2 id="quick-notes-heading">{fullPage ? <>Quick <span>Notes.</span></> : <>Quick notes <span className="quick-notes-count">{notes.length}</span></>}</h2>
          <p className="quick-notes-lead">Your notes saved from the browser extension.</p>
        </div>
      </div>
      {(error || message) &&
        <p className={'quick-notes-feedback' + (error ? ' is-error' : '')}
          role={error ? 'alert' : 'status'}>{error || message}</p>}
      {loading ? <p className="quick-notes-loading">Loading Quick Notes…</p> :
        visibleNotes.length ? (
          <div className="quick-notes-grid">
            {visibleNotes.map((note, index) =>
              <QuickNoteCard key={note.id} note={note} index={index} onDelete={deleteNote} />)}
          </div>
        ) : (
          <div className="quick-notes-empty">
            <span className="quick-notes-empty-icon" aria-hidden="true">✎</span>
            <h3>Your Quick Notes appear here.</h3>
            <p>Select Quick Notes in the Oge browser extension to save one.</p>
          </div>
        )}
      {!fullPage &&
        <Link className="quick-notes-view-all" href="/quick-notes">
          Open Quick Notes <span aria-hidden="true">→</span>
        </Link>}
      {fullPage && <footer><span>Captured from the browser extension.</span><span>OGENOTES · QUICK NOTES</span></footer>}
    </section>
  );
}
