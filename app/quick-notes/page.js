'use client';

import { useCallback, useEffect, useState } from 'react';
import ThemeToggle from '../components/theme-toggle';

async function readJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
  return data;
}
function when(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Just created';
}

export default function QuickNotesPage() {
  const [notes, setNotes] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setNotes(await readJson(await fetch('/api/quick-notes', { cache: 'no-store' }))); }
    catch (err) { setError(err.message || 'Could not load Quick Notes.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  function select(note) { setSelectedId(note.id); setContent(note.content || ''); setError(''); setMessage(''); }
  function newNote() { setSelectedId(''); setContent(''); setError(''); setMessage(''); }

  async function save(event) {
    event.preventDefault(); setSaving(true); setError(''); setMessage('');
    try {
      const note = await readJson(await fetch('/api/quick-notes', {
        method: selectedId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(selectedId ? { id: selectedId, content } : { content }),
      }));
      setSelectedId(note.id); setContent(note.content); setMessage('Quick Note saved.'); await load();
    } catch (err) { setError(err.message || 'Could not save this Quick Note.'); }
    finally { setSaving(false); }
  }

  async function remove() {
    if (!selectedId || !window.confirm('Delete this Quick Note permanently?')) return;
    setError(''); setMessage('');
    try { await readJson(await fetch('/api/quick-notes?id=' + encodeURIComponent(selectedId), { method: 'DELETE' })); newNote(); await load(); setMessage('Quick Note deleted.'); }
    catch (err) { setError(err.message || 'Could not delete this Quick Note.'); }
  }

  return (
    <main className="shell oge-shell oge-feature-page">
      <header className="oge-topbar">
        <a className="oge-brand" href="/"><span className="oge-brand-mark">O</span><span>OgeNotes</span></a>
        <nav className="oge-nav" aria-label="Main navigation"><a href="/">Home</a><a href="/notes">Notes</a><a href="/news">News</a></nav>
        <div className="oge-top-actions"><a className="oge-signin" href="/settings">Settings ↗</a><ThemeToggle /></div>
      </header>
      <section className="oge-notes-hero"><div className="oge-eyebrow"><span className="oge-status-dot" /> LIGHTWEIGHT CAPTURE</div><h1>Quick <span>Notes.</span></h1><p className="oge-hero-copy">Catch a thought before it disappears. Short notes, without the ceremony.</p></section>
      <section className="oge-notes-workspace oge-quick-workspace">
        <aside className="oge-notes-sidebar">
          <div className="oge-notes-sidebar-head"><span className="oge-section-kicker">YOUR QUICK NOTES</span><button type="button" className="oge-icon-button" onClick={newNote} aria-label="New Quick Note">＋</button></div>
          <div className="oge-subject-list">
            {notes.map((note) => <button key={note.id} type="button" className={selectedId === note.id ? 'oge-subject is-active' : 'oge-subject'} onClick={() => select(note)}><span>{note.title || 'New note'}</span><span aria-hidden="true">→</span></button>)}
            {!loading && !notes.length && <p className="oge-muted">No quick notes yet. Create one to get started.</p>}
          </div>
          <div className="oge-notes-sidebar-foot"><span>{notes.length} saved notes</span><button type="button" onClick={newNote}>＋ New note</button></div>
        </aside>
        <section className="oge-note-editor-panel oge-quick-editor">
          <form onSubmit={save} className="oge-note-editor-form">
            <div className="oge-note-editor-head"><span className="oge-section-kicker">{selectedId ? 'EDIT QUICK NOTE' : 'NEW QUICK NOTE'}</span>{selectedId && <button type="button" className="oge-danger-link" onClick={remove}>Delete</button>}</div>
            <p className="oge-muted">The first line becomes the note title.</p>
            <label htmlFor="quick-note-content">Your note</label>
            <textarea id="quick-note-content" className="oge-note-answer-input" value={content} onChange={(event) => setContent(event.target.value)} placeholder="Write a reminder, thought, or idea…" maxLength={20000} rows={12} />
            <div className="oge-note-editor-actions"><span>{content.length.toLocaleString()} / 20,000</span><button type="submit" className="oge-primary-link" disabled={saving}>{saving ? 'Saving…' : selectedId ? 'Save changes →' : 'Save note →'}</button></div>
            {error && <p className="oge-form-error" role="alert">{error}</p>}{message && <p className="oge-form-success" role="status">{message}</p>}
            {selectedId && <p className="oge-muted">Last saved {when(notes.find((note) => note.id === selectedId)?.updatedAt)}</p>}
          </form>
        </section>
      </section>
      <footer className="oge-footer"><a className="oge-brand oge-footer-brand" href="/"><span className="oge-brand-mark">O</span><span>OgeNotes</span></a><span>Capture it before you forget.</span><a href="/">Home ↗</a></footer>
    </main>
  );
}
