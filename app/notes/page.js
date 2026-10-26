'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import ThemeToggle from '../components/theme-toggle';

async function readJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
  return data;
}

function dateLabel(value) {
  if (!value) return 'Just created';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Recently edited';
  return date.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export default function NotesPage() {
  const [subjects, setSubjects] = useState([]);
  const [notes, setNotes] = useState([]);
  const [activeSubject, setActiveSubject] = useState('');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [heading, setHeading] = useState('');
  const [answer, setAnswer] = useState('');
  const [tagsText, setTagsText] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [subjectName, setSubjectName] = useState('');
  const [showSubjectForm, setShowSubjectForm] = useState(false);

  const load = useCallback(async (preferredSubject = '') => {
    setLoading(true);
    setError('');
    try {
      const subjectList = await readJson(await fetch('/api/subjects', { cache: 'no-store' }));
      setSubjects(subjectList);
      const slug = preferredSubject || activeSubject || subjectList[0]?.slug || '';
      setActiveSubject(slug);
      const noteList = await readJson(await fetch('/api/notes' + (slug ? '?subject=' + encodeURIComponent(slug) : ''), { cache: 'no-store' }));
      setNotes(noteList);
      if (selectedId) {
        const selected = noteList.find((note) => note.id === selectedId);
        if (selected) {
          setHeading(selected.heading);
          setAnswer(selected.answer);
          setTagsText((selected.tags || []).join(', '));
        } else {
          setSelectedId('');
          setHeading('');
          setAnswer('');
          setTagsText('');
        }
      }
    } catch (err) {
      setError(err.message || 'Could not load notes.');
    } finally {
      setLoading(false);
    }
  }, [activeSubject, selectedId]);

  useEffect(() => { load(); }, []); // Load once on entry; mutations explicitly refresh.

  const visibleNotes = useMemo(() => notes.filter((note) => {
    const needle = query.trim().toLowerCase();
    return !needle || (note.heading + ' ' + note.answer + ' ' + (note.tags || []).join(' ')).toLowerCase().includes(needle);
  }), [notes, query]);

  function selectNote(note) {
    setSelectedId(note.id);
    setHeading(note.heading);
    setAnswer(note.answer);
    setTagsText((note.tags || []).join(', '));
    setError('');
    setMessage('');
  }

  function newNote() {
    setSelectedId('');
    setHeading('');
    setAnswer('');
    setTagsText('');
    setError('');
    setMessage('');
  }

  async function saveNote(event) {
    event.preventDefault();
    setSaving(true); setError(''); setMessage('');
    try {
      const tags = tagsText.split(',').map((tag) => tag.trim()).filter(Boolean).slice(0, 10);
      const payload = { subjectSlug: activeSubject, heading, answer, tags };
      const response = await fetch('/api/notes', {
        method: selectedId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(selectedId ? { ...payload, id: selectedId } : payload),
      });
      const note = await readJson(response);
      setSelectedId(note.id);
      setHeading(note.heading);
      setAnswer(note.answer);
      setTagsText((note.tags || []).join(', '));
      setMessage('Note saved.');
      await load(activeSubject);
    } catch (err) { setError(err.message || 'Could not save note.'); }
    finally { setSaving(false); }
  }

  async function createSubject(event) {
    event.preventDefault(); setError(''); setMessage('');
    try {
      const subject = await readJson(await fetch('/api/subjects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: subjectName }) }));
      setSubjectName(''); setShowSubjectForm(false); setActiveSubject(subject.slug);
      await load(subject.slug); newNote(); setMessage('Subject created.');
    } catch (err) { setError(err.message || 'Could not create subject.'); }
  }

  async function deleteNote() {
    if (!selectedId || !window.confirm('Delete this note permanently?')) return;
    setError(''); setMessage('');
    try {
      await readJson(await fetch('/api/notes?id=' + encodeURIComponent(selectedId), { method: 'DELETE' }));
      newNote(); await load(activeSubject); setMessage('Note deleted.');
    } catch (err) { setError(err.message || 'Could not delete note.'); }
  }

  async function toggleFavorite(note) {
    try {
      await readJson(await fetch('/api/notes', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: note.id, favorite: !note.favorite }) }));
      await load(activeSubject);
    } catch (err) { setError(err.message || 'Could not update favorite.'); }
  }

  return (
    <main className="shell oge-shell oge-notes-page">
      <header className="oge-topbar">
        <a className="oge-brand" href="/"><span className="oge-brand-mark">O</span><span>OgeNotes</span></a>
        <nav className="oge-nav" aria-label="Main navigation"><a href="/">Home</a><a className="is-active" href="/notes">Notes</a><a href="/news">News</a></nav>
        <div className="oge-top-actions"><a className="oge-signin" href="/settings">Settings ↗</a><ThemeToggle /></div>
      </header>
      <section className="oge-notes-hero">
        <div className="oge-eyebrow"><span className="oge-status-dot" /> YOUR KNOWLEDGE LIBRARY</div>
        <h1>Make knowledge <span>stick.</span></h1>
        <p className="oge-hero-copy">Create organized notes, collect useful details, and come back to what matters.</p>
      </section>
      <section className="oge-notes-workspace">
        <aside className="oge-notes-sidebar">
          <div className="oge-notes-sidebar-head"><span className="oge-section-kicker">YOUR SUBJECTS</span><button type="button" className="oge-icon-button" onClick={() => setShowSubjectForm((value) => !value)} aria-label="Add subject">＋</button></div>
          {showSubjectForm && <form className="oge-subject-form" onSubmit={createSubject}><input value={subjectName} onChange={(event) => setSubjectName(event.target.value)} placeholder="Subject name" maxLength={60} required /><button type="submit">Add</button></form>}
          <div className="oge-subject-list">
            {subjects.map((subject) => <button key={subject.slug} type="button" className={activeSubject === subject.slug ? 'oge-subject is-active' : 'oge-subject'} onClick={() => { setActiveSubject(subject.slug); setSelectedId(''); setHeading(''); setAnswer(''); setTagsText(''); load(subject.slug); }}><span>{subject.name}</span><span aria-hidden="true">→</span></button>)}
            {!loading && !subjects.length && <p className="oge-muted">Create your first subject to get started.</p>}
          </div>
          <div className="oge-notes-sidebar-foot"><span>{notes.length} notes in this subject</span><button type="button" onClick={newNote}>＋ New note</button></div>
        </aside>
        <section className="oge-notes-list-panel">
          <div className="oge-notes-list-head"><div><span className="oge-section-kicker">YOUR NOTES</span><h2>{subjects.find((subject) => subject.slug === activeSubject)?.name || 'Notes'}</h2></div><button type="button" className="oge-primary-link" onClick={newNote}>＋ New note</button></div>
          <input className="oge-notes-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search headings, content, or tags…" aria-label="Search notes" />
          {loading ? <p className="oge-muted">Loading your notes…</p> : visibleNotes.length ? <div className="oge-note-list">{visibleNotes.map((note) => <article key={note.id} className={selectedId === note.id ? 'oge-note-list-item is-active' : 'oge-note-list-item'}><button className="oge-note-list-open" type="button" onClick={() => selectNote(note)}><strong>{note.heading}</strong><span>{note.answer.slice(0, 100)}</span><small>{dateLabel(note.updatedAt || note.createdAt)}</small></button><button className="oge-favorite-button" type="button" aria-label={note.favorite ? 'Remove favorite' : 'Add favorite'} onClick={() => toggleFavorite(note)}>{note.favorite ? '★' : '☆'}</button></article>)}</div> : <div className="oge-empty-state"><span>✎</span><h3>No notes here yet</h3><p>Create a note for this subject. Your notes are private to your account.</p><button type="button" className="oge-primary-link" onClick={newNote}>Create a note →</button></div>}
        </section>
        <section className="oge-note-editor-panel">
          <form onSubmit={saveNote} className="oge-note-editor-form">
            <div className="oge-note-editor-head"><span className="oge-section-kicker">{selectedId ? 'EDIT NOTE' : 'NEW NOTE'}</span>{selectedId && <button type="button" className="oge-danger-link" onClick={deleteNote}>Delete</button>}</div>
            <label htmlFor="note-heading">Heading</label>
            <input id="note-heading" className="oge-note-heading-input" value={heading} onChange={(event) => setHeading(event.target.value)} placeholder="Give this note a clear title" maxLength={160} required />
            <label htmlFor="note-answer">Content</label>
            <textarea id="note-answer" className="oge-note-answer-input" value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="Write your notes here…" maxLength={20000} rows={12} required />
            <label htmlFor="note-tags">Tags <span>(comma-separated)</span></label>
            <input id="note-tags" value={tagsText} onChange={(event) => setTagsText(event.target.value)} placeholder="e.g. exam, important, formula" />
            <div className="oge-note-editor-actions"><span>{answer.length} characters</span><button type="submit" className="oge-primary-link" disabled={saving || !activeSubject}>{saving ? 'Saving…' : selectedId ? 'Save changes →' : 'Save note →'}</button></div>
            {error && <p className="oge-form-error" role="alert">{error}</p>}
            {message && <p className="oge-form-success" role="status">{message}</p>}
          </form>
        </section>
      </section>
      <footer className="oge-footer"><a className="oge-brand oge-footer-brand" href="/"><span className="oge-brand-mark">O</span><span>OgeNotes</span></a><span>One idea at a time.</span><a href="/settings">Settings ↗</a></footer>
    </main>
  );
}
