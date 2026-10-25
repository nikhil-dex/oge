'use client';

import { useCallback, useEffect, useState } from 'react';
import ThemeToggle from '../components/theme-toggle';

async function readJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
  return data;
}
function blankLink() { return { title: '', url: '', description: '', category: '', tagsText: '' }; }

export default function SavedLinksPage() {
  const [links, setLinks] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [form, setForm] = useState(blankLink);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setLinks(await readJson(await fetch('/api/saved-links', { cache: 'no-store' }))); }
    catch (err) { setError(err.message || 'Could not load Saved Links.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  function select(link) {
    setSelectedId(link.id);
    setForm({ title: link.title || '', url: link.url || '', description: link.description || '', category: link.category || '', tagsText: (link.tags || []).join(', ') });
    setError(''); setMessage('');
  }
  function newLink() { setSelectedId(''); setForm(blankLink()); setError(''); setMessage(''); }
  function change(key, value) { setForm((current) => ({ ...current, [key]: value })); }

  async function save(event) {
    event.preventDefault(); setSaving(true); setError(''); setMessage('');
    const payload = { ...form, tags: form.tagsText.split(',').map((tag) => tag.trim()).filter(Boolean) };
    delete payload.tagsText;
    try {
      const link = await readJson(await fetch('/api/saved-links', {
        method: selectedId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(selectedId ? { ...payload, id: selectedId } : payload),
      }));
      setSelectedId(link.id); setForm({ title: link.title, url: link.url, description: link.description || '', category: link.category || '', tagsText: (link.tags || []).join(', ') });
      setMessage('Link saved.'); await load();
    } catch (err) { setError(err.message || 'Could not save this link.'); }
    finally { setSaving(false); }
  }

  async function remove() {
    if (!selectedId || !window.confirm('Remove this saved link?')) return;
    setError(''); setMessage('');
    try { await readJson(await fetch('/api/saved-links?id=' + encodeURIComponent(selectedId), { method: 'DELETE' })); newLink(); await load(); setMessage('Link removed.'); }
    catch (err) { setError(err.message || 'Could not remove this link.'); }
  }

  const visibleLinks = links.filter((link) => (link.title + ' ' + link.url + ' ' + (link.description || '') + ' ' + (link.tags || []).join(' ')).toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <main className="shell oge-shell oge-feature-page">
      <header className="oge-topbar">
        <a className="oge-brand" href="/"><span className="oge-brand-mark">O</span><span>OgeNotes</span></a>
        <nav className="oge-nav" aria-label="Main navigation"><a href="/">Home</a><a href="/notes">Notes</a><a href="/news">News</a></nav>
        <div className="oge-top-actions"><a className="oge-signin" href="/settings">Settings ↗</a><ThemeToggle /></div>
      </header>
      <section className="oge-notes-hero"><div className="oge-eyebrow"><span className="oge-status-dot" /> YOUR PERSONAL REFERENCE SHELF</div><h1>Keep the <span>good links.</span></h1><p className="oge-hero-copy">Save useful websites, tools, and references so you can find them again.</p></section>
      <section className="oge-saved-links-layout">
        <section className="oge-notes-list-panel">
          <div className="oge-notes-list-head"><div><span className="oge-section-kicker">YOUR COLLECTION</span><h2>Saved Links <span className="quick-notes-count">{links.length}</span></h2></div><button type="button" className="oge-primary-link" onClick={newLink}>＋ Add link</button></div>
          <input className="oge-notes-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search saved links…" aria-label="Search saved links" />
          {loading ? <p className="oge-muted">Loading links…</p> : visibleLinks.length ? <div className="oge-note-list">{visibleLinks.map((link) => <article key={link.id} className={selectedId === link.id ? 'oge-note-list-item is-active' : 'oge-note-list-item'}><button type="button" className="oge-note-list-open" onClick={() => select(link)}><strong>{link.title}</strong><span>{link.description || link.url}</span><small>{link.category || 'UNCATEGORIZED'} · {(link.tags || []).join(', ')}</small></button><a className="oge-link-open" href={link.url} target="_blank" rel="noopener noreferrer" aria-label={'Open ' + link.title}>↗</a></article>)}</div> : <div className="oge-empty-state"><span>↗</span><h3>No links found</h3><p>Save a useful website to build your personal reference shelf.</p><button type="button" className="oge-primary-link" onClick={newLink}>Add a link →</button></div>}
        </section>
        <section className="oge-note-editor-panel">
          <form onSubmit={save} className="oge-note-editor-form">
            <div className="oge-note-editor-head"><span className="oge-section-kicker">{selectedId ? 'EDIT SAVED LINK' : 'SAVE A NEW LINK'}</span>{selectedId && <button type="button" className="oge-danger-link" onClick={remove}>Delete</button>}</div>
            <label htmlFor="saved-link-title">Title</label><input id="saved-link-title" value={form.title} onChange={(event) => change('title', event.target.value)} maxLength={120} required placeholder="A useful website" />
            <label htmlFor="saved-link-url">URL</label><input id="saved-link-url" type="url" value={form.url} onChange={(event) => change('url', event.target.value)} maxLength={2048} required placeholder="https://example.com" />
            <label htmlFor="saved-link-description">Description</label><textarea id="saved-link-description" className="oge-note-answer-input oge-link-description" value={form.description} onChange={(event) => change('description', event.target.value)} maxLength={500} rows={4} placeholder="Why do you want to keep this?" />
            <label htmlFor="saved-link-category">Category</label><input id="saved-link-category" value={form.category} onChange={(event) => change('category', event.target.value)} maxLength={40} placeholder="Study, tools, reading…" />
            <label htmlFor="saved-link-tags">Tags <span>(comma-separated)</span></label><input id="saved-link-tags" value={form.tagsText} onChange={(event) => change('tagsText', event.target.value)} placeholder="reference, useful, read-later" />
            <div className="oge-note-editor-actions"><span>HTTP/HTTPS only</span><button type="submit" className="oge-primary-link" disabled={saving}>{saving ? 'Saving…' : selectedId ? 'Save changes →' : 'Save link →'}</button></div>
            {error && <p className="oge-form-error" role="alert">{error}</p>}{message && <p className="oge-form-success" role="status">{message}</p>}
          </form>
        </section>
      </section>
      <footer className="oge-footer"><a className="oge-brand oge-footer-brand" href="/"><span className="oge-brand-mark">O</span><span>OgeNotes</span></a><span>Keep your references close.</span><a href="/">Home ↗</a></footer>
    </main>
  );
}
