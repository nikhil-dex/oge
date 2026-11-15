'use client';

import Link from 'next/link';

import { useEffect, useState } from 'react';

async function readJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Could not load dashboard data.');
  return data;
}

function relativeDate(value) {
  if (!value) return 'Saved recently';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'Saved recently';
  const days = Math.floor((Date.now() - parsed.getTime()) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return days + ' days ago';
  return parsed.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

export default function HomeDashboard() {
  const [data, setData] = useState({
    loading: true, notes: [], noteCount: 0, subjectCount: 0, linkCount: 0, quickNoteCount: 0, error: '',
  });

  useEffect(() => {
    let cancelled = false;

    async function loadDashboard() {
      const [subjectsResult, linksResult, quickNotesResult] = await Promise.all([
        readJson('/api/subjects').catch((error) => ({ error: error.message, items: [] })),
        readJson('/api/saved-links').catch(() => []),
        readJson('/api/quick-notes').catch(() => []),
      ]);
      const subjects = Array.isArray(subjectsResult) ? subjectsResult : [];
      const notesBySubject = await Promise.all(subjects.map(async (subject) => {
        const notes = await readJson('/api/notes?subject=' + encodeURIComponent(subject.slug)).catch(() => []);
        return (Array.isArray(notes) ? notes : []).map((note) => ({
          ...note, subjectName: subject.name, subjectSlug: subject.slug,
        }));
      }));
      const allNotes = notesBySubject.flat();
      allNotes.sort((a, b) => {
        const aDate = Date.parse(a.updatedAt || a.createdAt || '') || 0;
        const bDate = Date.parse(b.updatedAt || b.createdAt || '') || 0;
        return bDate - aDate;
      });
      if (cancelled) return;
      setData({
        loading: false,
        notes: allNotes.slice(0, 5),
        noteCount: allNotes.length,
        subjectCount: subjects.length,
        linkCount: Array.isArray(linksResult) ? linksResult.length : 0,
        quickNoteCount: Array.isArray(quickNotesResult) ? quickNotesResult.length : 0,
        error: subjectsResult?.error || '',
      });
    }

    loadDashboard().catch((error) => {
      if (!cancelled) setData((current) => ({ ...current, loading: false, error: error.message || 'Could not load dashboard data.' }));
    });
    return () => { cancelled = true; };
  }, []);

  return (
    <section className="home-dashboard" aria-labelledby="home-dashboard-title">
      <div className="home-dashboard-heading">
        <div>
          <p className="eyebrow">YOUR WORKSPACE AT A GLANCE</p>
          <h2 id="home-dashboard-title">Pick up where you left off.</h2>
          <p className="home-dashboard-lead">Your latest notes and most-used destinations, all in one place.</p>
        </div>
        <Link className="home-dashboard-view-all" href="/notes">Open notes <span aria-hidden="true">→</span></Link>
      </div>

      <div className="home-dashboard-stats" aria-label="Workspace statistics">
        <Link className="home-dashboard-stat" href="/notes">
          <span className="home-dashboard-stat-icon" aria-hidden="true">▤</span>
          <span className="home-dashboard-stat-label">Notes</span>
          <strong>{data.loading ? '—' : data.noteCount}</strong>
        </Link>
        <Link className="home-dashboard-stat" href="/saved-links">
          <span className="home-dashboard-stat-icon" aria-hidden="true">↗</span>
          <span className="home-dashboard-stat-label">Saved links</span>
          <strong>{data.loading ? '—' : data.linkCount}</strong>
        </Link>
        <Link className="home-dashboard-stat" href="/settings">
          <span className="home-dashboard-stat-icon" aria-hidden="true">◫</span>
          <span className="home-dashboard-stat-label">Subjects</span>
          <strong>{data.loading ? '—' : data.subjectCount}</strong>
        </Link>
        <Link className="home-dashboard-stat" href="/quick-notes">
          <span className="home-dashboard-stat-icon" aria-hidden="true">✳</span>
          <span className="home-dashboard-stat-label">Quick notes</span>
          <strong>{data.loading ? '—' : data.quickNoteCount}</strong>
        </Link>
      </div>

      <div className="home-dashboard-content">
        <section className="home-dashboard-recent" aria-labelledby="home-recent-title">
          <div className="home-dashboard-section-heading">
            <div>
              <p className="eyebrow">RECENTLY UPDATED</p>
              <h3 id="home-recent-title">Recent notes</h3>
            </div>
            <Link href="/notes">View all <span aria-hidden="true">→</span></Link>
          </div>
          {data.loading ? (
            <p className="home-dashboard-empty">Loading your notes…</p>
          ) : data.notes.length ? (
            <div className="home-dashboard-note-list">
              {data.notes.map((note) => (
                <Link className="home-dashboard-note" href="/notes" key={note.id}>
                  <span className="home-dashboard-note-mark" aria-hidden="true">✎</span>
                  <span className="home-dashboard-note-copy">
                    <strong>{note.heading || 'Untitled note'}</strong>
                    <span>{note.subjectName}</span>
                  </span>
                  <span className="home-dashboard-note-date">{relativeDate(note.updatedAt || note.createdAt)}</span>
                  <span className="home-dashboard-note-arrow" aria-hidden="true">→</span>
                </Link>
              ))}
            </div>
          ) : (
            <div className="home-dashboard-empty">
              <span aria-hidden="true">✎</span>
              <strong>Your next idea starts here.</strong>
              <p>Create your first note and it will show up here.</p>
              <Link className="home-dashboard-action-link" href="/notes">Create a note <span aria-hidden="true">→</span></Link>
            </div>
          )}
          {data.error && <p className="home-dashboard-error" role="status">{data.error} Some dashboard counts may be unavailable.</p>}
        </section>

        <section className="home-dashboard-actions" aria-labelledby="home-actions-title">
          <p className="eyebrow">SHORTCUTS</p>
          <h3 id="home-actions-title">Quick actions</h3>
          <Link href="/notes"><span className="home-dashboard-action-icon" aria-hidden="true">＋</span><span><strong>Write a note</strong><small>Capture what you're learning</small></span><span aria-hidden="true">→</span></Link>
          <Link href="/saved-links"><span className="home-dashboard-action-icon" aria-hidden="true">↗</span><span><strong>Save a link</strong><small>Keep a useful resource close</small></span><span aria-hidden="true">→</span></Link>
          <Link href="/quick-notes"><span className="home-dashboard-action-icon" aria-hidden="true">✳</span><span><strong>Open Quick Notes</strong><small>Capture a passing thought</small></span><span aria-hidden="true">→</span></Link>
          <Link href="/extension"><span className="home-dashboard-action-icon" aria-hidden="true">⌁</span><span><strong>Browser extension</strong><small>Capture ideas from websites</small></span><span aria-hidden="true">→</span></Link>
        </section>
      </div>
    </section>
  );
}
