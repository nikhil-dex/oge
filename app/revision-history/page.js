'use client';

import { useCallback, useEffect, useState } from 'react';
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

export default function RevisionHistoryPage() {
  const [history, setHistory] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { const items = await readJson(await fetch('/api/revision-history', { cache: 'no-store' })); setHistory(items); setSelected(items[0] || null); }
    catch (err) { setError(err.message || 'Could not load revision history.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <main className="shell oge-shell oge-feature-page">
      <header className="oge-topbar"><a className="oge-brand" href="/"><span className="oge-brand-mark">O</span><span>OgeNotes</span></a><nav className="oge-nav" aria-label="Main navigation"><a href="/">Home</a><a href="/notes">Notes</a><a href="/news">News</a></nav><div className="oge-top-actions"><a className="oge-signin" href="/settings">Settings ↗</a><ThemeToggle /></div></header>
      <section className="oge-notes-hero"><div className="oge-eyebrow"><span className="oge-status-dot" /> YOUR EDIT TRAIL</div><h1>Nothing lost. <span>Everything learned.</span></h1><p className="oge-hero-copy">Browse previous versions of notes when you need to recover an earlier explanation.</p></section>
      <section className="oge-history-layout">
        <div className="oge-notes-list-panel"><div className="oge-notes-list-head"><div><span className="oge-section-kicker">PAST VERSIONS</span><h2>Revision History</h2></div><button className="oge-secondary-link" type="button" onClick={load} disabled={loading}>Refresh ↻</button></div>
          {loading ? <p className="oge-muted">Loading revision history…</p> : history.length ? <div className="oge-note-list">{history.map((item) => <button key={item.id} type="button" className={selected?.id === item.id ? 'oge-history-item is-active' : 'oge-history-item'} onClick={() => setSelected(item)}><strong>{item.previousHeading}</strong><span>{item.subjectSlug}</span><small>{dateLabel(item.revisedAt || item.savedAt)}</small></button>)}</div> : <div className="oge-empty-state"><span>◷</span><h3>No previous versions yet</h3><p>When you edit a note, its previous version is saved here.</p><a className="oge-primary-link" href="/notes">Open Notes →</a></div>}
        </div>
        <article className="oge-note-editor-panel oge-history-detail"><span className="oge-section-kicker">SELECTED VERSION</span>{selected ? <><h2>{selected.previousHeading}</h2><p className="oge-muted">Previous version saved {dateLabel(selected.revisedAt || selected.savedAt)}</p><div className="oge-history-answer">{selected.previousAnswer || 'This version did not contain any text.'}</div><a className="oge-secondary-link" href="/notes">Open Notes to continue editing →</a></> : <p className="oge-muted">Select a previous version to read its contents.</p>}</article>
      </section>
      {error && <p className="oge-form-error" role="alert">{error}</p>}
      <footer className="oge-footer"><a className="oge-brand oge-footer-brand" href="/"><span className="oge-brand-mark">O</span><span>OgeNotes</span></a><span>Every edit tells a story.</span><a href="/revision">Start revision ↗</a></footer>
    </main>
  );
}
