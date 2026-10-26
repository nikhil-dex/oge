'use client';

import { useCallback, useEffect, useState } from 'react';
import ThemeToggle from '../components/theme-toggle';

async function readJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
  return data;
}
function dateLabel(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function ExtensionPage() {
  const [status, setStatus] = useState({ connected: false, expiresAt: null });
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setStatus(await readJson(await fetch('/api/extension-token', { cache: 'no-store' }))); }
    catch (err) { setError(err.message || 'Could not load extension status.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function generate() {
    setWorking(true); setError(''); setMessage(''); setToken('');
    try {
      const data = await readJson(await fetch('/api/extension-token', { method: 'POST' }));
      setToken(data.token); setStatus({ connected: true, expiresAt: data.expiresAt });
      setMessage('Token created. Copy it into the extension now; it will not be shown again.');
    } catch (err) { setError(err.message || 'Could not generate token.'); }
    finally { setWorking(false); }
  }
  async function revoke() {
    if (!window.confirm('Revoke the current extension token? The extension will stop saving links until you generate a new token.')) return;
    setWorking(true); setError(''); setMessage(''); setToken('');
    try { await readJson(await fetch('/api/extension-token', { method: 'DELETE' })); setStatus({ connected: false, expiresAt: null }); setMessage('Extension token revoked.'); }
    catch (err) { setError(err.message || 'Could not revoke token.'); }
    finally { setWorking(false); }
  }
  async function copyToken() {
    try { await navigator.clipboard.writeText(token); setMessage('Token copied. Paste it into the extension.'); }
    catch { setError('Clipboard access failed. Select and copy the token manually.'); }
  }

  return (
    <main className="shell oge-shell oge-feature-page">
      <header className="oge-topbar"><a className="oge-brand" href="/"><span className="oge-brand-mark">O</span><span>OgeNotes</span></a><nav className="oge-nav" aria-label="Main navigation"><a href="/">Home</a><a href="/notes">Notes</a><a href="/news">News</a></nav><div className="oge-top-actions"><a className="oge-signin" href="/settings">Settings ↗</a><ThemeToggle /></div></header>
      <section className="oge-notes-hero"><div className="oge-eyebrow"><span className="oge-status-dot" /> CAPTURE WHILE YOU BROWSE</div><h1>Save it for <span>later.</span></h1><p className="oge-hero-copy">Send the current browser tab straight to your personal Saved Links collection.</p></section>
      <section className="oge-extension-content">
        <article className="oge-note-editor-panel oge-extension-card"><span className="oge-section-kicker">EXTENSION CONNECTION</span><h2>{loading ? 'Checking connection…' : status.connected ? 'Your extension token is active.' : 'Connect your browser.'}</h2><p className="oge-muted">{status.connected ? 'Token expires ' + dateLabel(status.expiresAt) + '. Generating a new token replaces the old one.' : 'Generate a token and paste it into the extension popup. The token is shown only once.'}</p>
          {token && <div className="oge-token-panel"><label htmlFor="extension-token">Copy this token now</label><textarea id="extension-token" value={token} readOnly rows={3} onFocus={(event) => event.target.select()} /><button className="oge-primary-link" type="button" onClick={copyToken}>Copy token</button></div>}
          <div className="oge-note-editor-actions"><button type="button" className="oge-primary-link" onClick={generate} disabled={working || loading}>{working ? 'Working…' : status.connected ? 'Rotate token' : 'Generate token'}</button>{status.connected && <button type="button" className="oge-danger-link" onClick={revoke} disabled={working}>Revoke token</button>}</div>
          {error && <p className="oge-form-error" role="alert">{error}</p>}{message && <p className="oge-form-success" role="status">{message}</p>}
        </article>
        <article className="oge-extension-instructions"><span className="oge-section-kicker">QUICK SETUP</span><ol><li>Download or clone the <code>extension/</code> folder from this repository.</li><li>Open <code>chrome://extensions</code> and enable Developer mode.</li><li>Select “Load unpacked” and choose the extension folder.</li><li>Open the extension popup and set the API base URL to your deployed OgeNotes origin (or <code>http://localhost:3000</code> during local development).</li><li>Paste the token above into the extension and save the current tab.</li></ol><p className="oge-muted">Treat the token like a password. It can save links to your account until it expires or you revoke it.</p></article>
      </section>
      <footer className="oge-footer"><a className="oge-brand oge-footer-brand" href="/"><span className="oge-brand-mark">O</span><span>OgeNotes</span></a><span>Keep the useful things you find.</span><a href="/saved-links">Saved Links ↗</a></footer>
    </main>
  );
}
