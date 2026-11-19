'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import ThemeToggle from '../components/theme-toggle';

async function readJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
  return data;
}
function when(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime())
    ? date.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : 'Just created';
}

/**
 * Quick Notes is an inbox for extension captures. The web app can view
 * and delete captures, but cannot create or edit them. AirNotes remains
 * the ordinary in-app writing surface.
 */
export default function QuickNotesClient({ apiPath = '/api/quick-notes' }) {
  const vaultBacked = apiPath === '/api/vault/quick-notes';
  const [notes, setNotes] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await readJson(await fetch(apiPath, { cache: 'no-store' }));
      setNotes(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err.message || 'Could not load Quick Notes.');
    } finally {
      setLoading(false);
    }
  }, [apiPath]);
  useEffect(() => { void load(); }, [load]);

  const selected = notes.find(note => note.id === selectedId) || null;
  function select(note) {
    setSelectedId(note.id);
    setError('');
    setMessage('');
  }
  async function remove() {
    if (!selected || !window.confirm('Delete this Quick Note permanently?')) return;
    setError('');
    setMessage('');
    try {
      await readJson(await fetch(apiPath + '?id=' + encodeURIComponent(selected.id) +
        (vaultBacked ? '&sha=' + encodeURIComponent(selected.sha || '') : ''),
      { method: 'DELETE' }));
      setSelectedId('');
      await load();
      setMessage('Quick Note deleted.');
    } catch (err) {
      setError(err.message || 'Could not delete this Quick Note.');
    }
  }

  return (
    <main className="shell oge-shell oge-feature-page">
      <header className="oge-topbar">
        <Link className="oge-brand" href="/"><span className="oge-brand-mark">O</span><span>OgeNotes</span></Link>
        <nav className="oge-nav" aria-label="Main navigation"><Link href="/">Home</Link><Link href="/notes">Notes</Link><Link href="/news">News</Link></nav>
        <div className="oge-top-actions"><Link className="oge-signin" href="/settings">Settings ↗</Link><ThemeToggle /></div>
      </header>
      <section className="oge-notes-hero">
        <div className="oge-eyebrow"><span className="oge-status-dot" /> LIGHTWEIGHT CAPTURE</div>
        <h1>Quick <span>Notes.</span></h1>
        <p className="oge-hero-copy">Your captures from the Oge browser extension.</p>
      </section>
      <section className="oge-notes-workspace oge-quick-workspace">
        <aside className="oge-notes-sidebar">
          <div className="oge-notes-sidebar-head">
            <span className="oge-section-kicker">YOUR QUICK NOTES</span>
          </div>
          <div className="oge-subject-list">
            {notes.map(note => <button key={note.id} type="button"
              className={selectedId === note.id ? 'oge-subject is-active' : 'oge-subject'}
              onClick={() => select(note)}>
              <span>{note.title || 'Untitled note'}</span><span aria-hidden="true">→</span>
            </button>)}
            {!loading && !notes.length &&
              <p className="oge-muted">No Quick Notes yet. Save one with the Oge browser extension.</p>}
          </div>
          <div className="oge-notes-sidebar-foot"><span>{notes.length} saved notes</span></div>
        </aside>
        <section className="oge-note-editor-panel oge-quick-editor">
          <div className="oge-note-editor-form">
            <div className="oge-note-editor-head">
              <span className="oge-section-kicker">{selected ? 'QUICK NOTE' : 'YOUR INBOX'}</span>
              {selected && <button type="button" className="oge-danger-link"
                onClick={remove}>Delete</button>}
            </div>
            {selected ? <>
              <p className="oge-muted">Saved from the browser extension.</p>
              <label htmlFor="quick-note-content">Your note</label>
              <textarea id="quick-note-content" className="oge-note-answer-input"
                value={selected.content || ''} readOnly rows={12}
                aria-label="Quick Note content" />
              <div className="oge-note-editor-actions">
                <span>{(selected.content || '').length.toLocaleString()} characters</span>
                <span>Read only</span>
              </div>
              <p className="oge-muted">Saved {when(selected.updatedAt)}</p>
            </> : <p className="oge-muted">Select a Quick Note to read it. Create new Quick Notes with the browser extension.</p>}
            {error && <p className="oge-form-error" role="alert">{error}</p>}
            {message && <p className="oge-form-success" role="status">{message}</p>}
          </div>
        </section>
      </section>
      <footer className="oge-footer">
        <Link className="oge-brand oge-footer-brand" href="/"><span className="oge-brand-mark">O</span><span>OgeNotes</span></Link>
        <span>Capture it before you forget.</span><Link href="/">Home ↗</Link>
      </footer>
    </main>
  );
}
