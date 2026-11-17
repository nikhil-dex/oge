'use client';

import { useCallback, useEffect, useState } from 'react';
import SiteNavbar from '../components/site-navbar';
import { buildDailyLessons } from '../../lib/learning-tracks.js';
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
  const [discovered, setDiscovered] = useState({});
  const [startDate, setStartDate] = useState('');
  const [noteLinkingEnabled, setNoteLinkingEnabled] = useState(false);
  const [lessonLinks, setLessonLinks] = useState({});
  const [chooser, setChooser] = useState(null);
  const [noteOptions, setNoteOptions] = useState([]);
  const [noteCursor, setNoteCursor] = useState(null);
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const data = await read(await fetch('/api/learning-tracks', { cache: 'no-store' }));
      setTracks(data.tracks);
      setNoteLinkingEnabled(data.noteLinkingEnabled === true);
    }
    catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    let active = true;
    Promise.resolve().then(() => { if (active) void load(); });
    return () => { active = false; };
  }, [load]);
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
      setMessage('Playlist added. Progress remains manual until you mark videos complete.');
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
  async function discover(track) {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const data = await read(await fetch('/api/learning-tracks/discover?id=' + encodeURIComponent(track.id), { cache: 'no-store' }));
      setDiscovered((current) => ({ ...current, [track.id]: data }));
      if (noteLinkingEnabled) {
        const linked = await read(await fetch('/api/learning-tracks/note-links?trackId=' + encodeURIComponent(track.id), { cache: 'no-store' }));
        setLessonLinks((current) => ({ ...current, [track.id]: linked.links }));
      }
      setMessage('Public playlist metadata loaded for this session only. No lesson content was saved.');
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function remove(track) {
    if (!window.confirm('Remove “' + track.title + '” and its progress record?')) return;
    setBusy(true); setError(''); setMessage('');
    try {
      await read(await fetch('/api/learning-tracks?id=' + encodeURIComponent(track.id), { method: 'DELETE' }));
      setTracks((current) => current.filter((item) => item.id !== track.id));
      setDiscovered((current) => {
        const next = { ...current }; delete next[track.id]; return next;
      });
      setLessonLinks((current) => {
        const next = { ...current }; delete next[track.id]; return next;
      });
      setChooser(null);
      setMessage('Learning track removed.');
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function loadNotes(cursor = null, append = false) {
    setBusy(true); setError('');
    try {
      const data = await read(await fetch('/api/learning-tracks/note-links?mode=notes' +
        (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), { cache: 'no-store' }));
      setNoteOptions((current) => append ? [...current, ...data.notes] : data.notes);
      setNoteCursor(data.nextCursor);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  function chooseNote(track, video) {
    setChooser({ trackId: track.id, videoId: video.videoId });
    setNoteOptions([]); setNoteCursor(null);
    void loadNotes();
  }
  async function linkNote(noteId) {
    if (!chooser || busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const { link } = await read(await fetch('/api/learning-tracks/note-links', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...chooser, noteId }),
      }));
      setLessonLinks((current) => ({
        ...current, [chooser.trackId]: [...(current[chooser.trackId] || []), link],
      }));
      setChooser(null);
      setMessage('The lesson now points to your existing private GitHub Note; no Note content was copied.');
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function unlinkNote(link) {
    if (!window.confirm('Remove this lesson link? The private GitHub Note will stay unchanged.')) return;
    setBusy(true); setError(''); setMessage('');
    try {
      await read(await fetch('/api/learning-tracks/note-links?' +
        new URLSearchParams({ trackId: link.trackId, videoId: link.videoId, noteId: link.noteId }), { method: 'DELETE' }));
      setLessonLinks((current) => ({
        ...current, [link.trackId]: (current[link.trackId] || []).filter((item) =>
          item.videoId !== link.videoId),
      }));
      setMessage('Lesson link removed. GitHub Note was not deleted.');
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function copyStarter(video) {
    try {
      await navigator.clipboard.writeText(video.title + '\n' + video.url + '\n\n');
      setMessage('Lesson starter copied. Open Vault Quick Capture and paste it into a new draft.');
      setError('');
    } catch { setError('Clipboard unavailable. Copy the video title and link manually.'); }
  }
  return <main className="shell oge-shell"><SiteNavbar />
    <section className={styles.hero}>
      <span className="oge-section-kicker">LEARNING TRACKS · PREVIEW</span>
      <h1>Make playlists into <span>progress.</span></h1>
      <p>Add a YouTube playlist, set a daily goal and mark completed videos. Optionally discover public video titles through the official YouTube API and preview the next seven lesson days. Discovery is on demand, not automatic. Notes are not created automatically. An isolated staging-only preview lets you link existing GitHub Notes and hand off lesson starters to Vault Quick Capture.</p>
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
        {tracks.map((track) => {
          const snapshot = discovered[track.id];
          const validProgress = snapshot && track.completedVideos <= snapshot.totalVideos;
          const days = validProgress ? buildDailyLessons(snapshot.videos, track.videosPerDay, track.completedVideos, startDate) : [];
          const currentDay = Math.floor(track.completedVideos / track.videosPerDay);
          const upcoming = days.slice(currentDay, currentDay + 7);
          return <article key={track.id} className={styles.track}>
            <h3>{track.title}</h3>
            <p>{track.videosPerDay} video{track.videosPerDay === 1 ? '' : 's'} per day · {track.completedVideos}{track.totalVideos == null ? ' completed (total unknown)' : ' / ' + track.totalVideos + ' completed'}</p>
            {track.totalVideos !== null && <progress max={track.totalVideos} value={track.completedVideos} aria-label={'Progress for ' + track.title} />}
            <div className={styles.actions}>
              <a href={track.url} target="_blank" rel="noopener noreferrer">Open playlist ↗</a>
              <button type="button" disabled={busy} onClick={() => discover(track)}>{snapshot ? 'Refresh lessons' : 'Discover lessons'}</button>
              <button type="button" disabled={busy || track.completedVideos <= 0} onClick={() => progress(track, -1)}>Undo one</button>
              <button type="button" disabled={busy || (track.totalVideos !== null && track.completedVideos >= track.totalVideos)} onClick={() => progress(track, 1)}>Completed one +</button>
              <button type="button" disabled={busy} onClick={() => remove(track)}>Remove</button>
            </div>
            {snapshot && <section className={styles.lessons} aria-label={'Lessons for ' + track.title}>
              <p>Snapshot: {snapshot.totalVideos} public playlist entries. Read-only discovery; titles and order can change. Completed count follows playlist order, not video identity.</p>
              {track.totalVideos !== null && track.totalVideos !== snapshot.totalVideos &&
                <p className={styles.error}>Your manually recorded total ({track.totalVideos}) differs from the discovered count ({snapshot.totalVideos}). This does not overwrite your saved total.</p>}
              {!validProgress ? <p className={styles.error}>Recorded progress exceeds discovered videos. Schedule hidden until the data is reconciled.</p> :
                <>
                  <label className={styles.scheduleDate}>Optional schedule start date<input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></label>
                  <p>{days.length} lesson days total · showing {upcoming.length} upcoming day{upcoming.length === 1 ? '' : 's'}</p>
                  {upcoming.length === 0 && <p>All discovered videos marked complete.</p>}
                  <ol className={styles.dayList}>
                    {upcoming.map((day) => <li key={day.day}>
                      <strong>Day {day.day}{day.date ? ' · ' + day.date : ''}</strong>
                      <ul>{day.videos.map((video) => <li key={video.position}>
                        {video.completed ? '✓ ' : ''}<a href={video.url} target="_blank" rel="noopener noreferrer">{video.title}</a>
                        {noteLinkingEnabled && <>
                          {(lessonLinks[track.id] || []).some((link) => link.videoId === video.videoId) ?
                            <span className={styles.noteActions}>
                              <span>Linked to private Note</span>
                              <button type="button" disabled={busy} onClick={() => unlinkNote(
                                lessonLinks[track.id].find((link) => link.videoId === video.videoId))}>Unlink</button>
                            </span> :
                            <button type="button" disabled={busy} onClick={() => chooseNote(track, video)}>Link existing Note</button>}
                          <button type="button" disabled={busy} onClick={() => copyStarter(video)}>Copy for Quick Capture</button>
                          <a href="/vault/capture" target="_blank" rel="noopener noreferrer">Open Vault Capture</a>
                        </>}
                      </li>)}</ul>
                    </li>)}
                  </ol>
                  {chooser?.trackId === track.id && <section className={styles.notePicker} aria-label="Choose a committed private GitHub Note">
                    <strong>Choose a private GitHub Note for this video</strong>
                    <p>Read-only owner-verified picker (8 per page). Titles stay in browser memory; only Note ID is linked. Do not link Notes from a different Vault.</p>
                    {noteOptions.length === 0 && <p>No committed Notes found on this page.</p>}
                    {noteOptions.map((note) => <div className={styles.noteChoice} key={note.id}>
                      <span>{note.heading}</span>
                      <button type="button" disabled={busy} onClick={() => linkNote(note.id)}>Link this Note</button>
                    </div>)}
                    <div className={styles.actions}>
                      {noteCursor && <button type="button" disabled={busy} onClick={() => loadNotes(noteCursor, true)}>More Notes</button>}
                      <button type="button" disabled={busy} onClick={() => setChooser(null)}>Cancel</button>
                    </div>
                  </section>}
                </>}
            </section>}
          </article>;
        })}
      </section>
    </section>
  </main>;
}
