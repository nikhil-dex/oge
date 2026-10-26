'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import SiteNavbar from '../components/site-navbar';
import ThemeToggle from '../components/theme-toggle';

async function readJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
  return data;
}
const ratings = [
  { value: 'again', label: 'Again', description: 'I could not recall it', interval: '1 day', hint: '↻', className: 'rating-again' },
  { value: 'hard', label: 'Hard', description: 'It took real effort', interval: '3 days', hint: '⌁', className: 'rating-hard' },
  { value: 'good', label: 'Good', description: 'I recalled it', interval: '7 days', hint: '✓', className: 'rating-good' },
  { value: 'easy', label: 'Easy', description: 'I knew it confidently', interval: '14 days', hint: '✦', className: 'rating-easy' },
];

export default function RevisionPage() {
  const [notes, setNotes] = useState([]);
  const [index, setIndex] = useState(0);
  const [subject, setSubject] = useState('all');
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [completed, setCompleted] = useState(0);

  const load = useCallback(async () => {
    setLoading(true); setError(''); setMessage('');
    try { setNotes(await readJson(await fetch('/api/revision', { cache: 'no-store' }))); setIndex(0); setRevealed(false); }
    catch (err) { setError(err.message || 'Could not load revision cards.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const subjects = useMemo(() => [...new Set(notes.map((note) => note.subjectSlug).filter(Boolean))].sort((a, b) => a.localeCompare(b)), [notes]);
  const queue = useMemo(() => subject === 'all' ? notes : notes.filter((note) => note.subjectSlug === subject), [notes, subject]);
  const note = queue[index] || null;

  function skipCard() {
    if (!note || queue.length < 2) return;
    const skippedId = note.id;
    setNotes((current) => {
      const currentIndex = current.findIndex((item) => item.id === skippedId);
      if (currentIndex < 0) return current;
      const copy = [...current];
      const [skipped] = copy.splice(currentIndex, 1);
      copy.push(skipped);
      return copy;
    });
    setIndex(0);
    setRevealed(false);
    setMessage('Card moved to the back of your queue.');
  }

  async function rate(rating) {
    if (!note || saving) return;
    setSaving(true); setError(''); setMessage('');
    try {
      const result = await readJson(await fetch('/api/revision', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
        body: JSON.stringify({ id: note.id, rating }),
      }));
      setNotes((current) => current.filter((item) => item.id !== note.id));
      setIndex(0); setRevealed(false); setCompleted((count) => count + 1);
      setMessage('Review saved. Next review: ' + new Date(result.reviewDueAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) + '.');
    } catch (err) { setError(err.message || 'Could not record revision.'); }
    finally { setSaving(false); }
  }

  const dueTotal = notes.length;
  return (
    <main className="shell oge-shell oge-feature-page oge-workflow-page">
      <SiteNavbar actions={<><a className="oge-signin" href="/settings">Settings <span aria-hidden="true">↗</span></a><ThemeToggle /></>} />
      <section className="oge-notes-hero oge-workflow-hero"><div className="oge-eyebrow"><span className="oge-status-dot" /> ACTIVE RECALL · SPACED REPETITION</div><h1>Learn it. <span>Keep it.</span></h1><p className="oge-hero-copy">Recall the answer before revealing it. Rate how difficult it felt and OgeNotes schedules when to revisit it.</p></section>

      <section className="oge-workflow-summary" aria-label="Revision queue summary">
        <div className="oge-workflow-stat"><span className="oge-section-kicker">DUE NOW</span><strong>{loading ? '…' : dueTotal}</strong><span>Cards waiting for review</span></div>
        <div className="oge-workflow-stat"><span className="oge-section-kicker">COMPLETED THIS SESSION</span><strong>{completed}</strong><span>Reviews saved this visit</span></div>
        <div className="oge-workflow-stat"><span className="oge-section-kicker">SCHEDULING</span><strong>1–14 days</strong><span>Based on your recall rating</span></div>
      </section>

      <section className="oge-revision-workspace">
        <div className="oge-revision-workspace-heading"><div><span className="oge-section-kicker">YOUR STUDY QUEUE</span><h2>One card at a time.</h2></div><div className="oge-revision-filter-wrap"><label htmlFor="revision-subject-filter">Subject</label><select id="revision-subject-filter" value={subject} onChange={(event) => { setSubject(event.target.value); setIndex(0); setRevealed(false); setMessage(''); }}><option value="all">All subjects</option>{subjects.map((item) => <option key={item} value={item}>{item}</option>)}</select></div></div>

        <div className="oge-revision-queue-progress"><div><span>{loading ? 'Preparing your queue…' : note ? 'CARD ' + (index + 1) + ' OF ' + queue.length : 'QUEUE STATUS'}</span><span>{note ? note.subjectSlug : dueTotal + ' due'}</span></div><div className="oge-revision-progress-track"><span style={{ width: note ? ((index + 1) / queue.length * 100) + '%' : '100%' }} /></div></div>

        {loading ? <div className="oge-revision-stage oge-revision-stage-refined"><div className="oge-revision-skeleton" /><p className="oge-muted">Loading your revision cards…</p></div> : note ? <>
          <article className="oge-revision-card oge-revision-card-refined">
            <div className="oge-revision-card-top"><span className="oge-section-kicker">QUESTION</span><span className="oge-revision-card-tag">{note.tags?.length ? note.tags.slice(0, 3).join(' · ') : 'Active recall'}</span></div>
            <h2>{note.heading}</h2>
            {!revealed ? <div className="oge-revision-hidden"><span aria-hidden="true">✳</span><p>Take a moment to answer from memory before revealing the explanation.</p><button type="button" className="oge-primary-link" onClick={() => setRevealed(true)}>Reveal answer <span aria-hidden="true">↓</span></button></div> : <div className="oge-revision-answer oge-revision-answer-refined"><div className="oge-revision-answer-heading"><span className="oge-section-kicker">ANSWER</span><span>Compare with your recall</span></div><p>{note.answer}</p></div>}
            <div className="oge-revision-card-foot"><span>{note.reviewCount || 0} previous reviews</span><a href="/revision-history">View revision history ↗</a></div>
          </article>
          {revealed && <section className="oge-revision-rating-section" aria-labelledby="rating-heading"><div className="oge-revision-rating-heading"><h3 id="rating-heading">How well did you remember?</h3><p>Your rating sets the next review date.</p></div><div className="oge-revision-ratings oge-revision-ratings-refined">{ratings.map((rating) => <button key={rating.value} type="button" className={'oge-revision-rating ' + rating.className} disabled={saving} onClick={() => rate(rating.value)}><span className="oge-rating-hint" aria-hidden="true">{rating.hint}</span><strong>{rating.label}</strong><span>{rating.description}</span><small>Again in {rating.interval}</small></button>)}</div></section>}
          <div className="oge-revision-controls oge-revision-controls-refined"><button type="button" className="oge-secondary-link" onClick={skipCard} disabled={queue.length < 2 || saving}>Skip for now <span aria-hidden="true">→</span></button><span>Skipped cards return to the end of your queue.</span><button type="button" className="oge-secondary-link" onClick={load} disabled={loading || saving}>Refresh queue ↻</button></div>
        </> : <div className="oge-revision-stage oge-revision-stage-refined"><div className="oge-empty-state"><span>✦</span><h3>{subject === 'all' ? "You're caught up." : 'No cards due for this subject.'}</h3><p>{subject === 'all' ? 'You have reviewed every card currently due. New reviews will appear here when they are scheduled.' : 'Choose another subject or come back when a card is due.'}</p><a className="oge-primary-link" href="/notes">Create or edit notes →</a></div><button type="button" className="oge-secondary-link" onClick={load} disabled={loading}>Check for due cards ↻</button></div>}

        {error && <p className="oge-form-error" role="alert">{error}</p>}{message && <p className="oge-form-success" role="status">{message}</p>}
      </section>
      <footer className="oge-footer"><a className="oge-brand oge-footer-brand" href="/"><span className="oge-brand-mark">O</span><span>OgeNotes</span></a><span>Recall beats rereading.</span><a href="/revision-history">Revision history ↗</a></footer>
    </main>
  );
}
