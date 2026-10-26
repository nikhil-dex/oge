'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import SiteNavbar from '../components/site-navbar';
import ThemeToggle from '../components/theme-toggle';

async function readJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
  return data;
}
function dateLabel(value) {
  if (!value) return 'Date unavailable';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Date unavailable' : date.toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function excerpt(value, length = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > length ? text.slice(0, length).trimEnd() + '…' : text;
}

export default function RevisionHistoryPage() {
  const [history, setHistory] = useState([]);
  const [selected, setSelected] = useState(null);
  const [query, setQuery] = useState('');
  const [subject, setSubject] = useState('all');
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async (keepSelection = false) => {
    setLoading(true); setError('');
    try {
      const items = await readJson(await fetch('/api/revision-history', { cache: 'no-store' }));
      setHistory(items);
      setSelected((current) => keepSelection ? (items.find((item) => item.id === current?.id) || items[0] || null) : (items[0] || null));
    } catch (err) { setError(err.message || 'Could not load revision history.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const subjects = useMemo(() => [...new Set(history.map((item) => item.subjectSlug).filter(Boolean))].sort((a, b) => a.localeCompare(b)), [history]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return history.filter((item) => {
      const matchesSubject = subject === 'all' || item.subjectSlug === subject;
      const matchesQuery = !needle || [item.previousHeading, item.previousAnswer, item.currentHeading, item.subjectSlug].some((value) => String(value || '').toLowerCase().includes(needle));
      return matchesSubject && matchesQuery;
    });
  }, [history, query, subject]);

  async function restoreVersion() {
    if (!selected || restoring) return;
    if (!window.confirm('Restore "' + (selected.previousHeading || 'Untitled note') + '" as the current version? Your current note will be saved to history first.')) return;
    setRestoring(true); setError(''); setMessage('');
    try {
      const result = await readJson(await fetch('/api/revision-history', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
        body: JSON.stringify({ noteId: selected.noteId, revisionIndex: selected.revisionIndex }),
      }));
      setMessage(result.message || 'Previous version restored.');
      await load(false);
    } catch (err) { setError(err.message || 'Could not restore this version.'); }
    finally { setRestoring(false); }
  }

  return (
    <main className="shell oge-shell oge-feature-page oge-workflow-page">
      <SiteNavbar actions={<><a className="oge-signin" href="/settings">Settings <span aria-hidden="true">↗</span></a><ThemeToggle /></>} />
      <section className="oge-notes-hero oge-workflow-hero"><div className="oge-eyebrow"><span className="oge-status-dot" /> YOUR EDIT TRAIL</div><h1>Nothing lost. <span>Everything learned.</span></h1><p className="oge-hero-copy">Find earlier versions, compare the saved content, and safely restore a note when you need to go back.</p></section>

      <section className="oge-workflow-summary" aria-label="Revision history summary">
        <div className="oge-workflow-stat"><span className="oge-section-kicker">SAVED VERSIONS</span><strong>{loading ? '…' : history.length}</strong><span>Across your notes</span></div>
        <div className="oge-workflow-stat"><span className="oge-section-kicker">SUBJECTS</span><strong>{loading ? '…' : subjects.length}</strong><span>With saved history</span></div>
        <div className="oge-workflow-stat"><span className="oge-section-kicker">RECOVERY</span><strong>Available</strong><span>Current content is backed up before restore</span></div>
      </section>

      {error && <p className="oge-form-error" role="alert">{error}</p>}
      {message && <p className="oge-form-success" role="status">{message}</p>}

      <section className="oge-history-workspace" aria-label="Browse saved versions">
        <aside className="oge-note-editor-panel oge-history-browser">
          <div className="oge-workflow-panel-heading"><div><span className="oge-section-kicker">VERSION LIBRARY</span><h2>Saved versions</h2></div><button className="oge-secondary-link" type="button" onClick={() => load(true)} disabled={loading}>Refresh ↻</button></div>
          <label className="oge-history-search-label" htmlFor="history-search">Search history</label>
          <input className="oge-history-search" id="history-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a title or phrase…" />
          <label className="oge-history-search-label" htmlFor="history-subject">Subject</label>
          <select className="oge-history-filter" id="history-subject" value={subject} onChange={(event) => setSubject(event.target.value)}><option value="all">All subjects</option>{subjects.map((item) => <option value={item} key={item}>{item}</option>)}</select>
          <div className="oge-history-results-count">{loading ? 'Loading versions…' : filtered.length + ' of ' + history.length + ' versions'}</div>
          <div className="oge-history-version-list">
            {loading ? <p className="oge-muted">Loading your revision history…</p> : filtered.length ? filtered.map((item) => <button key={item.id} type="button" className={'oge-history-version' + (selected?.id === item.id ? ' is-active' : '')} onClick={() => { setSelected(item); setMessage(''); }} aria-pressed={selected?.id === item.id}>
              <span className="oge-history-version-meta"><span>{item.subjectSlug || 'Unsorted'}</span><time>{dateLabel(item.revisedAt || item.savedAt)}</time></span>
              <strong>{item.previousHeading}</strong><span className="oge-history-version-excerpt">{excerpt(item.previousAnswer, 110) || 'No answer text in this version.'}</span>
            </button>) : <div className="oge-empty-state oge-history-empty"><span>◷</span><h3>{history.length ? 'No matching versions' : 'No previous versions yet'}</h3><p>{history.length ? 'Try another search or choose a different subject.' : 'When you edit and save a note, the previous content is preserved here.'}</p>{!history.length && <a className="oge-primary-link" href="/notes">Open Notes →</a>}</div>}
          </div>
        </aside>

        <article className="oge-note-editor-panel oge-history-inspector">
          {selected ? <>
            <div className="oge-history-inspector-top"><span className="oge-section-kicker">VERSION PREVIEW</span><span className="oge-settings-pill">{selected.subjectSlug || 'Unsorted'}</span></div>
            <h2>{selected.previousHeading}</h2>
            <p className="oge-muted">Saved {dateLabel(selected.revisedAt || selected.savedAt)}</p>
            <div className="oge-history-current-ref"><span className="oge-section-kicker">CURRENT NOTE</span><strong>{selected.currentHeading || 'Untitled note'}</strong><a href="/notes">Open notes ↗</a></div>
            <div className="oge-history-answer"><span className="oge-section-kicker">PREVIOUS CONTENT</span><div>{selected.previousAnswer || 'This version did not contain any text.'}</div></div>
            <div className="oge-history-restore-actions"><button className="oge-primary-link" type="button" onClick={restoreVersion} disabled={restoring}>{restoring ? 'Restoring…' : 'Restore this version ↶'}</button><a className="oge-secondary-link" href="/notes">Open Notes</a></div>
            <p className="oge-settings-note">Restoring creates another history entry containing the current content first. This action cannot be undone, but you can restore another saved version later.</p>
          </> : <div className="oge-empty-state"><span>↶</span><h3>Select a version</h3><p>Choose a saved version from the list to preview it here.</p></div>}
        </article>
      </section>
      <footer className="oge-footer"><a className="oge-brand oge-footer-brand" href="/"><span className="oge-brand-mark">O</span><span>OgeNotes</span></a><span>Every edit tells a story.</span><a href="/revision">Start revision ↗</a></footer>
    </main>
  );
}
