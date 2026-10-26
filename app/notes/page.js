'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import SiteNavbar from '../components/site-navbar';
import { markdownHtml } from '../../lib/markdown.js';
import ThemeToggle from '../components/theme-toggle';

async function responseJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
  return data;
}

function savedLabel(value) {
  if (!value) return 'Just created';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Recently edited';
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function NotesPage() {
  const [subjects, setSubjects] = useState([]);
  const [notes, setNotes] = useState([]);
  const [activeSubject, setActiveSubject] = useState('');
  const [query, setQuery] = useState('');
  const [globalSearch, setGlobalSearch] = useState(false);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [selectedTag, setSelectedTag] = useState('');
  const [sortOrder, setSortOrder] = useState('latest');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [noteDialog, setNoteDialog] = useState(false);
  const [editingId, setEditingId] = useState('');
  const [readerNote, setReaderNote] = useState(null);
  const [heading, setHeading] = useState('');
  const [answer, setAnswer] = useState('');
  const [tagsText, setTagsText] = useState('');
  const [subjectName, setSubjectName] = useState('');
  const [showSubjectForm, setShowSubjectForm] = useState(false);
  const [subjectSaving, setSubjectSaving] = useState(false);
  const [preview, setPreview] = useState(false);
  const [answerFullscreen, setAnswerFullscreen] = useState(false);
  const [draftStatus, setDraftStatus] = useState('');
  const answerRef = useRef(null);

  const load = useCallback(async (preferredSubject = '') => {
    setLoading(true);
    setError('');
    try {
      const [subjectList, noteList] = await Promise.all([
        responseJson(await fetch('/api/subjects', { cache: 'no-store' })),
        responseJson(await fetch('/api/notes', { cache: 'no-store' })),
      ]);
      const slug = preferredSubject || activeSubject || subjectList[0]?.slug || '';
      setSubjects(subjectList);
      setNotes(noteList);
      setActiveSubject(slug);
    } catch (err) {
      setError(err.message || 'Could not load your notes.');
    } finally {
      setLoading(false);
    }
  }, [activeSubject]);

  useEffect(() => { load(); }, []); // Initial load only; changes refresh explicitly.

  const availableTags = useMemo(
    () => [...new Set(notes.flatMap((note) => Array.isArray(note.tags) ? note.tags : []))].sort(),
    [notes],
  );

  const visibleNotes = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return notes
      .filter((note) => globalSearch || !activeSubject || note.subjectSlug === activeSubject)
      .filter((note) => !needle || (note.heading + ' ' + note.answer + ' ' + (note.tags || []).join(' ')).toLocaleLowerCase().includes(needle))
      .filter((note) => !favoritesOnly || note.favorite)
      .filter((note) => !selectedTag || (note.tags || []).includes(selectedTag))
      .sort((a, b) => {
        if (sortOrder === 'oldest') return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
        if (sortOrder === 'title-asc') return a.heading.localeCompare(b.heading);
        if (sortOrder === 'title-desc') return b.heading.localeCompare(a.heading);
        return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
      });
  }, [notes, activeSubject, query, globalSearch, favoritesOnly, selectedTag, sortOrder]);

  const active = subjects.find((subject) => subject.slug === activeSubject);

  function openNewNote() {
    setEditingId('');
    setHeading('');
    setAnswer('');
    setTagsText('');
    setError('');
    setMessage('');
    setPreview(false);
    setAnswerFullscreen(false);
    setDraftStatus('');
    setNoteDialog(true);
  }

  function editNote(note) {
    setEditingId(note.id);
    setHeading(note.heading);
    setAnswer(note.answer);
    setTagsText((note.tags || []).join(', '));
    setReaderNote(null);
    setError('');
    setMessage('');
    setPreview(false);
    setAnswerFullscreen(false);
    setDraftStatus('');
    setNoteDialog(true);
  }

  async function saveNote(event) {
    event.preventDefault();
    if (saving || !activeSubject) return;
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const tags = [...new Set(tagsText.split(',').map((tag) => tag.trim().toLowerCase()).filter(Boolean))].slice(0, 10);
      const payload = { subjectSlug: activeSubject, heading: heading.trim(), answer: answer.trim(), tags };
      const note = await responseJson(await fetch('/api/notes', {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editingId ? { ...payload, id: editingId } : payload),
      }));
      setNoteDialog(false);
      setAnswerFullscreen(false);
      setPreview(false);
      setEditingId(note.id);
      setMessage('Note saved successfully.');
      await load(activeSubject);
    } catch (err) {
      setError(err.message || 'Could not save this note.');
    } finally {
      setSaving(false);
    }
  }

  async function toggleFavorite(note) {
    setError('');
    try {
      await responseJson(await fetch('/api/notes', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: note.id, favorite: !note.favorite }),
      }));
      await load(activeSubject);
    } catch (err) {
      setError(err.message || 'Could not update favorite.');
    }
  }

  async function deleteNote(note) {
    if (!window.confirm(`Delete “${note.heading}” permanently? This cannot be undone.`)) return;
    setError('');
    try {
      await responseJson(await fetch('/api/notes?id=' + encodeURIComponent(note.id), { method: 'DELETE' }));
      setReaderNote(null);
      setNoteDialog(false);
      setMessage('Note deleted.');
      await load(activeSubject);
    } catch (err) {
      setError(err.message || 'Could not delete this note.');
    }
  }

  async function createSubject(event) {
    event.preventDefault();
    if (subjectSaving) return;
    setSubjectSaving(true);
    setError('');
    try {
      const subject = await responseJson(await fetch('/api/subjects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: subjectName }),
      }));
      setSubjectName('');
      setShowSubjectForm(false);
      await load(subject.slug);
      setMessage('Subject created.');
    } catch (err) {
      setError(err.message || 'Could not create the subject.');
    } finally {
      setSubjectSaving(false);
    }
  }

  function insertFormatting(format) {
    const field = answerRef.current;
    if (!field) return;
    const start = field.selectionStart;
    const end = field.selectionEnd;
    const selected = answer.slice(start, end);
    let before = '';
    let value = selected || 'text';
    let after = '';
    if (format === 'bold') { before = '**'; after = '**'; }
    if (format === 'code') { before = '`'; after = '`'; }
    if (format === 'codeblock') { before = '```bash\n'; after = '\n```'; value = selected || 'command'; }
    if (format === 'list') {
      const lineStart = answer.lastIndexOf('\n', start - 1) + 1;
      const lineEnd = answer.indexOf('\n', end);
      const actualEnd = lineEnd < 0 ? answer.length : lineEnd;
      const list = answer.slice(lineStart, actualEnd).split('\n').map((line) => `- ${line}`).join('\n');
      setAnswer(`${answer.slice(0, lineStart)}${list}${answer.slice(actualEnd)}`);
      return;
    }
    setAnswer(`${answer.slice(0, start)}${before}${value}${after}${answer.slice(end)}`);
  }

  useEffect(() => {
    if (!noteDialog && !readerNote) return undefined;
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      if (answerFullscreen) { setAnswerFullscreen(false); return; }
      if (noteDialog && !saving) { setNoteDialog(false); setPreview(false); return; }
      setReaderNote(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [noteDialog, readerNote, answerFullscreen, saving]);

  return (
    <main className="shell">
      <SiteNavbar actions={<ThemeToggle />} />

      <nav className="subject-nav" aria-label="Subjects">
        {subjects.map((subject) => (
          <span className="subject-item" key={subject.slug}>
            <button
              type="button"
              className={subject.slug === activeSubject ? 'subject-tab active' : 'subject-tab'}
              onClick={() => { setActiveSubject(subject.slug); setGlobalSearch(false); setQuery(''); setSelectedTag(''); setError(''); }}
            >
              {subject.name}
            </button>
          </span>
        ))}
        <button type="button" className="subject-add" onClick={() => setShowSubjectForm((value) => !value)} aria-expanded={showSubjectForm}>＋ Add subject</button>
      </nav>

      {showSubjectForm && (
        <form className="subject-create-form" onSubmit={createSubject}>
          <input value={subjectName} onChange={(event) => setSubjectName(event.target.value)} placeholder="New subject name" maxLength={60} required aria-label="New subject name" />
          <button className="add-button" type="submit" disabled={subjectSaving}>{subjectSaving ? 'Adding…' : 'Add subject'}</button>
          <button className="text-button" type="button" onClick={() => setShowSubjectForm(false)}>Cancel</button>
        </form>
      )}

      <section className="intro">
        <div>
          <p className="eyebrow">YOUR PERSONAL KNOWLEDGE BASE</p>
          <h1>{globalSearch ? 'Your library' : (active?.name || 'Your')} notes<span className="period">.</span></h1>
          <p className="subtitle">A clear place for the commands, concepts, and things you learn.</p>
        </div>
        <div className="intro-actions">
          <button className="add-button" type="button" onClick={openNewNote} disabled={!activeSubject}><span>＋</span> Add a note</button>
        </div>
      </section>

      <section className="stats" aria-label="Note statistics">
        <div className="stat"><span className="stat-number">{String(notes.length).padStart(2, '0')}</span><span className="stat-label">TOTAL NOTES</span></div>
        <div className="stat-divider" />
        <div className="stat"><span className="stat-number">{String(subjects.length).padStart(2, '0')}</span><span className="stat-label">SUBJECTS</span></div>
        <div className="stat-spacer" />
        <div className="search-wrap"><span aria-hidden="true">⌕</span><input type="search" placeholder={globalSearch ? 'Search all subjects…' : 'Search this subject…'} aria-label="Search notes" value={query} onChange={(event) => setQuery(event.target.value)} />{query && <button type="button" className="search-clear" onClick={() => setQuery('')} aria-label="Clear search">×</button>}</div>
        <button type="button" className={globalSearch ? 'global-search-toggle active' : 'global-search-toggle'} aria-pressed={globalSearch} onClick={() => { setGlobalSearch((value) => !value); setQuery(''); setSelectedTag(''); }}>⌕ {globalSearch ? 'All subjects' : 'Search all subjects'}</button>
      </section>

      <section className="notes-section">
        <div className="section-heading">
          <div><p className="eyebrow">THE LIBRARY</p><h2>{globalSearch ? 'Search results' : 'All notes'} <span className="count-pill">{visibleNotes.length}</span></h2></div>
          <label className="sort-control">Sort <select value={sortOrder} onChange={(event) => setSortOrder(event.target.value)} aria-label="Sort notes"><option value="latest">Latest updated</option><option value="oldest">Oldest first</option><option value="title-asc">Title A–Z</option><option value="title-desc">Title Z–A</option></select></label>
        </div>
        <div className="note-filters" aria-label="Note filters">
          <button type="button" className={favoritesOnly ? 'filter-chip active' : 'filter-chip'} aria-pressed={favoritesOnly} onClick={() => setFavoritesOnly((value) => !value)}>★ Favorites</button>
          {availableTags.length > 0 && <label className="tag-filter">Tag <select value={selectedTag} onChange={(event) => setSelectedTag(event.target.value)} aria-label="Filter notes by tag"><option value="">All tags</option>{availableTags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}</select></label>}
          {(query || globalSearch || favoritesOnly || selectedTag) && <button type="button" className="clear-filters" onClick={() => { setQuery(''); setGlobalSearch(false); setFavoritesOnly(false); setSelectedTag(''); }}>Clear all</button>}
        </div>

        {error && !noteDialog && <p className="page-error" role="alert">{error}</p>}
        {message && !noteDialog && <p className="form-success" role="status">{message}</p>}
        {loading ? <div className="empty-state" role="status"><span className="empty-icon">◌</span><h3>Loading notes…</h3><p>Getting your library ready.</p></div>
          : visibleNotes.length ? <div className="notes-grid">{visibleNotes.map((note, index) => (
            <article className="note-card" key={note.id}>
              <button type="button" className="card-open" onClick={() => setReaderNote(note)} aria-label={`Open note: ${note.heading}`}>
                <span className="card-top"><span className="note-index">NO. {String(index + 1).padStart(2, '0')}</span><span className="note-badges">{note.favorite && <span title="Favorite">★</span>}</span></span>
                <span className="note-title">{note.heading}</span>
                <span className="note-preview">{note.answer}</span>
                <span className="card-tags">{(note.tags || []).map((tag) => <span key={tag} className="tag-chip">{tag}</span>)}</span>
                <span className="card-bottom">◷ <span>{savedLabel(note.updatedAt || note.createdAt)}</span></span>
              </button>
              <div className="note-card-actions" aria-label={`Actions for ${note.heading}`}>
                <button type="button" className={note.favorite ? 'metadata-action selected' : 'metadata-action'} onClick={() => toggleFavorite(note)} aria-pressed={Boolean(note.favorite)} aria-label={note.favorite ? 'Remove favorite' : 'Add favorite'} title={note.favorite ? 'Remove favorite' : 'Add favorite'}>★</button>
                <button type="button" className="edit-note" onClick={() => editNote(note)} aria-label={`Edit note: ${note.heading}`} title="Edit note">✎</button>
                <button type="button" className="delete-note" onClick={() => deleteNote(note)} aria-label={`Delete note: ${note.heading}`} title="Delete note">×</button>
              </div>
            </article>
          ))}</div> : <div className="empty-state"><span className="empty-icon">⌕</span><h3>{query ? 'No notes found' : 'Start your collection'}</h3><p>{query ? 'Try another search, or clear the filters.' : 'Add a note to this subject, then come back to study it.'}</p><button className="add-button" type="button" onClick={openNewNote} disabled={!activeSubject}><span>＋</span> Add your first note</button></div>}
      </section>

      <footer><span>Built for learning, one note at a time.</span><span>PRIVATE · SUBJECT BASED</span></footer>

      {noteDialog && <div className="modal-backdrop editor-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setNoteDialog(false); }}>
        <section className="dialog editor-dialog" role="dialog" aria-modal="true" aria-labelledby="formTitle">
          <button className="close-button" type="button" onClick={() => !saving && setNoteDialog(false)} aria-label="Close form">×</button>
          <p className="eyebrow">{editingId ? 'EDIT NOTE' : 'GROW YOUR LIBRARY'}</p>
          <h2 id="formTitle">{editingId ? 'Edit note' : 'Add a note'}<span className="period">.</span></h2>
          <p className="form-subtitle">{editingId ? 'Update the heading, tags, or answer.' : 'Give it a clear heading and capture what you learned.'}</p>
          <form id="noteForm" onSubmit={saveNote}>
            <label htmlFor="heading">HEADING</label>
            <input id="heading" maxLength={160} placeholder="e.g. What does chmod do?" value={heading} onChange={(event) => setHeading(event.target.value)} required />
            <label htmlFor="noteTags">TAGS <span className="field-hint">comma-separated · up to 10</span></label>
            <input id="noteTags" maxLength={260} placeholder="e.g. arrays, exam, important" value={tagsText} onChange={(event) => setTagsText(event.target.value)} />
            {answerFullscreen ? createPortal(
              <div className="answer-workspace is-fullscreen">
                <div className="label-row"><label htmlFor="answer">ANSWER</label><span>Markdown · use headings, lists, quotes, links, and code blocks</span><button type="button" className="answer-expand-button" onClick={() => setAnswerFullscreen(false)} aria-label="Exit full-screen writing area" title="Exit full screen (Esc)">↙ Exit full screen</button></div>
                <div className="editor-toolbar" aria-label="Answer formatting"><button type="button" onClick={() => insertFormatting('bold')} title="Bold">B</button><button type="button" onClick={() => insertFormatting('code')} title="Inline code">&lt;/&gt;</button><button type="button" onClick={() => insertFormatting('list')} title="Bullet list">• List</button><button type="button" onClick={() => insertFormatting('codeblock')} title="Code block">{'{ }'}</button><span>Formatting shortcuts</span><span className="draft-status" role="status" aria-live="polite">{draftStatus}</span></div>
                <div className="editor-tabs"><button type="button" className={!preview ? 'active' : ''} onClick={() => setPreview(false)}>Write</button><button type="button" className={preview ? 'active' : ''} onClick={() => setPreview(true)}>Preview</button></div>
                {!preview ? <textarea ref={answerRef} form="noteForm" id="answer" rows={6} maxLength={20000} placeholder="Write your explanation here…" value={answer} onChange={(event) => { setAnswer(event.target.value); setDraftStatus('Unsaved changes'); }} required /> : <div className="answer-preview">{answer ? <div dangerouslySetInnerHTML={{ __html: markdownHtml(answer) }} /> : <p className="preview-placeholder">Nothing to preview yet.</p>}</div>}
              </div>,
              document.body
            ) : <div className="answer-workspace">
              <div className="label-row"><label htmlFor="answer">ANSWER</label><span>Markdown · use headings, lists, quotes, links, and code blocks</span><button type="button" className="answer-expand-button" onClick={() => setAnswerFullscreen(true)} aria-label="Expand writing area to full screen" title="Expand writing area">⛶ Expand</button></div>
              <div className="editor-toolbar" aria-label="Answer formatting"><button type="button" onClick={() => insertFormatting('bold')} title="Bold">B</button><button type="button" onClick={() => insertFormatting('code')} title="Inline code">&lt;/&gt;</button><button type="button" onClick={() => insertFormatting('list')} title="Bullet list">• List</button><button type="button" onClick={() => insertFormatting('codeblock')} title="Code block">{'{ }'}</button><span>Formatting shortcuts</span><span className="draft-status" role="status" aria-live="polite">{draftStatus}</span></div>
              <div className="editor-tabs"><button type="button" className={!preview ? 'active' : ''} onClick={() => setPreview(false)}>Write</button><button type="button" className={preview ? 'active' : ''} onClick={() => setPreview(true)}>Preview</button></div>
              {!preview ? <textarea ref={answerRef} id="answer" rows={8} maxLength={20000} placeholder="Write your explanation here…" value={answer} onChange={(event) => { setAnswer(event.target.value); setDraftStatus('Unsaved changes'); }} required /> : <div className="answer-preview">{answer ? <div dangerouslySetInnerHTML={{ __html: markdownHtml(answer) }} /> : <p className="preview-placeholder">Nothing to preview yet.</p>}</div>}
            </div>}
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="submit-button" type="submit" disabled={saving || !activeSubject}><span>{saving ? 'Saving…' : editingId ? 'Save changes' : 'Save note'}</span><span aria-hidden="true">→</span></button>
          </form>
        </section>
      </div>}

      {readerNote && <div className="reader-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setReaderNote(null); }}>
        <article className="reader-panel" role="dialog" aria-modal="true" aria-labelledby="readerTitle">
          <div className="reader-toolbar"><span className="reader-kicker">NOTE · {active?.name || 'LIBRARY'}</span><div className="reader-toolbar-actions">
            <button type="button" className="reader-step-button" onClick={() => editNote(readerNote)} aria-label="Edit note" title="Edit note">✎</button>
            <button type="button" className="close-button reader-close" onClick={() => setReaderNote(null)} aria-label="Close note">×</button>
          </div></div>
          <div className="reader-content"><p className="eyebrow">{active?.name || 'YOUR LIBRARY'}</p><h2 id="readerTitle">{readerNote.heading}</h2><div className="reader-meta">Saved {savedLabel(readerNote.updatedAt || readerNote.createdAt)}</div><div className="reader-answer" dangerouslySetInnerHTML={{ __html: markdownHtml(readerNote.answer) }} />
            {(readerNote.tags || []).length > 0 && <div className="reader-tags">{readerNote.tags.map((tag) => <span key={tag} className="tag-chip">{tag}</span>)}</div>}
            <div className="reader-footer-actions"><button type="button" className="study-button secondary-study-button" onClick={() => toggleFavorite(readerNote)}>{readerNote.favorite ? '★ Remove favorite' : '☆ Add favorite'}</button><button type="button" className="add-button" onClick={() => editNote(readerNote)}>Edit note →</button></div>
          </div>
        </article>
      </div>}
    </main>
  );
}
