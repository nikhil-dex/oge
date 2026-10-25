'use client';

import { useCallback, useEffect, useState } from 'react';
import ThemeToggle from '../components/theme-toggle';

async function readJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
  return data;
}
const ratings = [
  { value: 'again', label: 'Again', description: 'I could not recall it', interval: '1 day' },
  { value: 'hard', label: 'Hard', description: 'It took real effort', interval: '3 days' },
  { value: 'good', label: 'Good', description: 'I recalled it', interval: '7 days' },
  { value: 'easy', label: 'Easy', description: 'I knew it confidently', interval: '14 days' },
];

export default function RevisionPage() {
  const [notes, setNotes] = useState([]);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setNotes(await readJson(await fetch('/api/revision', { cache: 'no-store' }))); setIndex(0); setRevealed(false); }
    catch (err) { setError(err.message || 'Could not load revision cards.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function rate(rating) {
    const note = notes[index];
    if (!note || saving) return;
    setSaving(true); setError(''); setMessage('');
    try {
      const result = await readJson(await fetch('/api/revision', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: note.id, rating }) }));
      setNotes((current) => current.filter((item) => item.id !== note.id));
      setIndex(0); setRevealed(false);
      setMessage('Revision saved. Next review: ' + new Date(result.reviewDueAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) + '.');
    } catch (err) { setError(err.message || 'Could not record revision.'); }
    finally { setSaving(false); }
  }

  const note = notes[index];
  return (
    <main className="shell oge-shell oge-feature-page">
      <header className="oge-topbar"><a className="oge-brand" href="/"><span className="oge-brand-mark">O</span><span>OgeNotes</span></a><nav className="oge-nav" aria-label="Main navigation"><a href="/">Home</a><a href="/notes">Notes</a><a href="/news">News</a></nav><div className="oge-top-actions"><a className="oge-signin" href="/settings">Settings ↗</a><ThemeToggle /></div></header>
      <section className="oge-notes-hero"><div className="oge-eyebrow"><span className="oge-status-dot" /> ACTIVE RECALL</div><h1>Learn it. <span>Keep it.</span></h1><p className="oge-hero-copy">Try to recall the answer before revealing it. Your rating schedules the next review.</p></section>
      <section className="oge-revision-stage">
        {loading ? <p className="oge-muted">Loading your revision cards…</p> : note ? <>
          <div className="oge-revision-progress"><span className="oge-section-kicker">CARD {index + 1} OF {notes.length}</span><span>{note.subjectSlug}</span></div>
          <article className="oge-revision-card"><span className="oge-section-kicker">QUESTION</span><h2>{note.heading}</h2>{revealed ? <div className="oge-revision-answer"><span className="oge-section-kicker">ANSWER</span><p>{note.answer}</p></div> : <button type="button" className="oge-primary-link" onClick={() => setRevealed(true)}>Reveal answer →</button>}</article>
          {revealed && <div className="oge-revision-ratings">{ratings.map((rating) => <button key={rating.value} type="button" className={'oge-revision-rating rating-' + rating.value} disabled={saving} onClick={() => rate(rating.value)}><strong>{rating.label}</strong><span>{rating.description}</span><small>Review in {rating.interval}</small></button>)}</div>}
          <div className="oge-revision-controls"><button type="button" className="oge-secondary-link" onClick={() => { setIndex((current) => (current + 1) % notes.length); setRevealed(false); }}>Skip this card →</button><span>{note.reviewCount} previous reviews</span></div>
        </> : <div className="oge-empty-state"><span>↻</span><h3>You're caught up.</h3><p>There are no notes due for review right now. Create notes or return when your next review is due.</p><a className="oge-primary-link" href="/notes">Open Notes →</a></div>}
        {error && <p className="oge-form-error" role="alert">{error}</p>}{message && <p className="oge-form-success" role="status">{message}</p>}
        <button type="button" className="oge-secondary-link" onClick={load} disabled={loading}>Refresh revision cards ↻</button>
      </section>
      <footer className="oge-footer"><a className="oge-brand oge-footer-brand" href="/"><span className="oge-brand-mark">O</span><span>OgeNotes</span></a><span>Recall beats rereading.</span><a href="/revision-history">Revision history ↗</a></footer>
    </main>
  );
}
