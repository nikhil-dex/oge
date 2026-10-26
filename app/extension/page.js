'use client';

import { useCallback, useEffect, useState } from 'react';
import SiteNavbar from '../components/site-navbar';
import ThemeToggle from '../components/theme-toggle';

async function readJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
  return data;
}
function dateLabel(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function ExtensionPage() {
  const [status, setStatus] = useState({ connected: false, expiresAt: null, createdAt: null });
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
      const data = await readJson(await fetch('/api/extension-token', { method: 'POST', cache: 'no-store' }));
      setToken(data.token); setStatus({ connected: true, expiresAt: data.expiresAt, createdAt: data.createdAt });
      setMessage('Token created. Copy it into the extension now; it will not be shown again.');
    } catch (err) { setError(err.message || 'Could not generate token.'); }
    finally { setWorking(false); }
  }
  async function revoke() {
    if (!window.confirm('Revoke the current extension token? The extension will stop saving links until you generate a new token.')) return;
    setWorking(true); setError(''); setMessage(''); setToken('');
    try { await readJson(await fetch('/api/extension-token', { method: 'DELETE', cache: 'no-store' })); setStatus({ connected: false, expiresAt: null, createdAt: null }); setMessage('Extension token revoked.'); }
    catch (err) { setError(err.message || 'Could not revoke token.'); }
    finally { setWorking(false); }
  }
  async function copyToken() {
    try { await navigator.clipboard.writeText(token); setMessage('Token copied. Paste it into the extension.'); }
    catch { setError('Clipboard access failed. Select and copy the token manually.'); }
  }

  return (
    <main className="shell oge-shell oge-feature-page oge-workflow-page">
      <SiteNavbar actions={<><a className="oge-signin" href="/settings">Settings <span aria-hidden="true">↗</span></a><ThemeToggle /></>} />
      <section className="oge-notes-hero oge-workflow-hero"><div className="oge-eyebrow"><span className="oge-status-dot" /> CAPTURE WHILE YOU BROWSE</div><h1>Save it for <span>later.</span></h1><p className="oge-hero-copy">Send the current browser tab straight to your personal Saved Links collection. Your token stays private and can be revoked at any time.</p></section>

      <section className="oge-workflow-summary" aria-label="Extension overview">
        <div className="oge-workflow-stat"><span className="oge-section-kicker">CONNECTION</span><strong>{loading ? 'Checking…' : status.connected ? 'Connected' : 'Not connected'}</strong><span>{loading ? 'Checking token status' : status.connected ? 'Token is valid' : 'Generate a token to begin'}</span></div>
        <div className="oge-workflow-stat"><span className="oge-section-kicker">EXPIRES</span><strong>{status.connected ? dateLabel(status.expiresAt) : '—'}</strong><span>Tokens expire after 90 days</span></div>
        <div className="oge-workflow-stat"><span className="oge-section-kicker">DESTINATION</span><strong>Saved Links</strong><span>Only your signed-in account</span></div>
      </section>

      <section className="oge-extension-content oge-extension-content-refined">
        <article className="oge-note-editor-panel oge-extension-card oge-workflow-card">
          <div className="oge-workflow-card-title"><span className="oge-workflow-icon" aria-hidden="true">↗</span><div><span className="oge-section-kicker">SECURE CONNECTION</span><h2>{loading ? 'Checking your connection' : status.connected ? 'Your extension is active.' : 'Connect your browser.'}</h2></div></div>
          <p className="oge-muted">{status.connected ? 'Created ' + dateLabel(status.createdAt) + '. You can rotate the token if you think it has been exposed.' : 'Create a one-time token and paste it into the OgeNotes browser extension. For security, the full token is only displayed immediately after creation.'}</p>
          {token && <div className="oge-token-panel oge-token-panel-refined"><label htmlFor="extension-token">YOUR ONE-TIME TOKEN</label><textarea id="extension-token" value={token} readOnly rows={3} onFocus={(event) => event.target.select()} /><div className="oge-token-actions"><button className="oge-primary-link" type="button" onClick={copyToken}>Copy token <span aria-hidden="true">▣</span></button><span>Do not share this token.</span></div></div>}
          <div className="oge-note-editor-actions oge-extension-actions"><button type="button" className="oge-primary-link" onClick={generate} disabled={working || loading}>{working ? 'Working…' : status.connected ? 'Rotate token ↻' : 'Generate token →'}</button>{status.connected && <button type="button" className="oge-danger-link" onClick={revoke} disabled={working}>Revoke token</button>}</div>
          {error && <p className="oge-form-error" role="alert">{error}</p>}{message && <p className="oge-form-success" role="status">{message}</p>}
        </article>

        <article className="oge-extension-instructions oge-workflow-card">
          <span className="oge-section-kicker">QUICK SETUP</span><h2>Ready in a few steps.</h2>
          <ol className="oge-extension-steps"><li><span>01</span><div><strong>Load the extension</strong><p>Download or clone this repository and open its <code>extension/</code> folder. In Chrome, visit <code>chrome://extensions</code>, enable Developer mode, then choose “Load unpacked”.</p></div></li><li><span>02</span><div><strong>Set the API address</strong><p>In the extension popup, enter your deployed OgeNotes origin, or <code>http://localhost:3000</code> for local development.</p></div></li><li><span>03</span><div><strong>Connect your account</strong><p>Paste the token created here into the extension popup and save the settings.</p></div></li><li><span>04</span><div><strong>Save a page</strong><p>Open any page you want to keep and use the extension. Find it later in your <a href="/saved-links">Saved Links</a>.</p></div></li></ol>
          <p className="oge-settings-note">Security tip: never commit a token to GitHub or send it in screenshots. If it may be exposed, revoke it here and generate a replacement.</p>
        </article>
      </section>
      <footer className="oge-footer"><a className="oge-brand oge-footer-brand" href="/"><span className="oge-brand-mark">O</span><span>OgeNotes</span></a><span>Keep the useful things you find.</span><a href="/saved-links">Saved Links ↗</a></footer>
    </main>
  );
}
