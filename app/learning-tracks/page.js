'use client';

import { useCallback, useEffect, useState } from 'react';
import SiteNavbar from '../components/site-navbar';
import styles from './learning-tracks.module.css';

async function read(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Could not complete request.');
  return data;
}
export default function LearningTracksPage() {
  const [tracks, setTracks] = useState([]);
  const [form, setForm] = useState({ title: '', url: '', videosPerDay: '2', totalVideos: '' });
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setTracks((await read(await fetch('/api/learning-tracks', { cache: 'no-store' }))).tracks); }
    catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function create(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const { track } = await read(await fetch('/api/learning-tracks', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form, videosPerDay: Number(form.videosPerDay),
          totalVideos: form.totalVideos.trim() ? Number(form.totalVideos) : null,
        }),
      }));
      setTracks((current) => [track, ...current]);
      setForm({ title: '', url: '', videosPerDay: '2', totalVideos: '' });
      setMessage('Playlist added. Progress is tracked manually for now.');
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function progress(track, delta) {
    setBusy(true); setError(''); setMessage('');
    try {
      const { track: updated } = await read(await fetch('/api/learning-tracks', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: track.id, expectedCompleted: track.completedVideos, completedVideos: track.completedVideos + delta }),
      }));
      setTracks((current) => current.map((item) => item.id === track.id ? updated : item));
    } catch (err) { setError(err.message); await load(); }
    finally { setBusy(false); }
  }
  async function remove(track) {
    if (!window.confirm('Remove “' + track.title + '” and its progress record?')) return;
    setBusy(true); setError(''); setMessage('');
    try {
      await read(await fetch('/api/learning-tracks?id=' + encodeURIComponent(track.id), { method: 'DELETE' }));
      setTracks((current) => current.filter((item) => item.id !== track.id));
      setMessage('Learning track removed.');
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  return <main className="shell oge-shell"><SiteNavbar />
    <section className={styles.hero}>
      <span className="oge-section-kicker">LEARNING TRACKS · PREVIEW</span>
      <h1>Make playlists into <span>progress.</span></h1>
      <p>Add a YouTube playlist, choose a daily video goal, and record what you finish. This preview saves only playlist and progress metadata. Video metadata sync, lessons and GitHub-backed notes are not enabled yet.</p>
    </section>
    <section className={styles.grid}>
      <form className={styles.panel} onSubmit={create}>
        <h2>New track</h2>
        <label>Track name<input required maxLength={120} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Machine learning course" /></label>
        <label>YouTube playlist URL<input required type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://www.youtube.com/playlist?list=…" /></label>
        <label>Videos per day<input required type="number" min="1" max="20" value={form.videosPerDay} onChange={(e) => setForm({ ...form, videosPerDay: e.target.value })} /></label>
        <label>Total videos (optional)<input type="number" min="1" max="10000" value={form.totalVideos} onChange={(e) => setForm({ ...form, totalVideos: e.target.value })} placeholder="Unknown" /></label>
        <button type="submit" disabled={busy}>Add learning track</button>
      </form>
      <section className={styles.panel} aria-label="Your learning tracks">
        <div className={styles.head}><h2>Your tracks</h2><button type="button" onClick={load} disabled={loading || busy}>Refresh</button></div>
        {error && <p role="alert" className={styles.error}>{error}</p>}
        {message && <p role="status">{message}</p>}
        {loading && <p>Loading tracks…</p>}
        {!loading && tracks.length === 0 && <p>No tracks yet. Add your first playlist.</p>}
        {tracks.map((track) => <article key={track.id} className={styles.track}>
          <h3>{track.title}</h3>
          <p>{track.videosPerDay} video{track.videosPerDay === 1 ? '' : 's'} per day · {track.completedVideos}{track.totalVideos == null ? ' completed (total unknown)' : ' / ' + track.totalVideos + ' completed'}</p>
          {track.totalVideos !== null && <progress max={track.totalVideos} value={track.completedVideos} aria-label={'Progress for ' + track.title} />}
          <div className={styles.actions}>
            <a href={track.url} target="_blank" rel="noopener noreferrer">Open playlist ↗</a>
            <button type="button" disabled={busy || track.completedVideos <= 0} onClick={() => progress(track, -1)}>Undo one</button>
            <button type="button" disabled={busy || (track.totalVideos !== null && track.completedVideos >= track.totalVideos)} onClick={() => progress(track, 1)}>Completed one +</button>
            <button type="button" disabled={busy} onClick={() => remove(track)}>Remove</button>
          </div>
        </article>)}
      </section>
    </section>
  </main>;
}
