'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const ACCENTS = [
  { id: 'green', label: 'Forest', color: '#40795e' },
  { id: 'blue', label: 'Ocean', color: '#376fc0' },
  { id: 'purple', label: 'Violet', color: '#7955b5' },
  { id: 'rose', label: 'Rose', color: '#b94f70' },
];
const PIXEL_MODES = [
  ['random', 'Rotate effects'], ['wave', 'Pixel waves'], ['sparkle', 'Sparkles'],
  ['rain', 'Digital rain'], ['pulse', 'Pulse grid'], ['heartbeat', 'Heartbeat'],
  ['geometry', 'Geometry'], ['glitch', 'Glitch'], ['orbit', 'Orbit rings'],
];

async function responseJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
  return data;
}

function readLocal(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}

export default function SettingsClient() {
  const [subjects, setSubjects] = useState([]);
  const [subjectName, setSubjectName] = useState('');
  const [subjectLoading, setSubjectLoading] = useState(true);
  const [subjectBusy, setSubjectBusy] = useState(false);
  const [deleting, setDeleting] = useState('');
  const [subjectMessage, setSubjectMessage] = useState('');
  const [theme, setTheme] = useState('dark');
  const [accent, setAccent] = useState('green');
  const [secondary, setSecondary] = useState('blue');
  const [pixel, setPixel] = useState({ enabled: true, color: 'accent', mode: 'random', speed: 'normal', density: 'normal' });
  const [geminiKey, setGeminiKey] = useState('');
  const [geminiConfigured, setGeminiConfigured] = useState(false);
  const [geminiUpdatedAt, setGeminiUpdatedAt] = useState(null);
  const [geminiBusy, setGeminiBusy] = useState(false);
  const [geminiMessage, setGeminiMessage] = useState('');
  const [geminiMessageType, setGeminiMessageType] = useState('status');
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupMessage, setBackupMessage] = useState('');
  const fileRef = useRef(null);

  const refreshSubjects = useCallback(async () => {
    const data = await responseJson(await fetch('/api/subjects', { cache: 'no-store' }));
    setSubjects(Array.isArray(data) ? data : []);
  }, []);

  useEffect(() => {
    let cancelled = false;
    refreshSubjects().catch((error) => { if (!cancelled) setSubjectMessage(error.message); }).finally(() => { if (!cancelled) setSubjectLoading(false); });
    fetch('/api/gemini-key', { cache: 'no-store' }).then(responseJson).then((data) => {
      if (!cancelled) { setGeminiConfigured(Boolean(data.configured)); setGeminiUpdatedAt(data.updatedAt || null); }
    }).catch((error) => { if (!cancelled) { setGeminiMessage(error.message); setGeminiMessageType('alert'); } });
    const savedTheme = readLocal('theme', 'dark');
    const savedAccent = readLocal('accent', 'green');
    const savedSecondary = readLocal('secondary', 'blue');
    setTheme(['light', 'dark'].includes(savedTheme) ? savedTheme : 'dark');
    setAccent(ACCENTS.some((item) => item.id === savedAccent) ? savedAccent : 'green');
    setSecondary(ACCENTS.some((item) => item.id === savedSecondary) ? savedSecondary : 'blue');
    try {
      const saved = JSON.parse(localStorage.getItem('ogenotes-pixel-strip-settings') || '{}');
      setPixel({
        enabled: saved.enabled !== false,
        color: saved.color === 'white' ? 'white' : 'accent',
        mode: PIXEL_MODES.some(([id]) => id === saved.mode) ? saved.mode : 'random',
        speed: ['slow', 'normal', 'fast'].includes(saved.speed) ? saved.speed : 'normal',
        density: ['fine', 'normal', 'bold'].includes(saved.density) ? saved.density : 'normal',
      });
    } catch { /* Keep safe defaults if stored preferences are malformed. */ }
    return () => { cancelled = true; };
  }, [refreshSubjects]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('theme', theme);
  }, [theme]);
  useEffect(() => {
    document.documentElement.dataset.primary = accent;
    if (accent === 'green') delete document.documentElement.dataset.accent;
    else document.documentElement.dataset.accent = accent;
    localStorage.setItem('accent', accent);
  }, [accent]);
  useEffect(() => {
    document.documentElement.dataset.secondary = secondary;
    localStorage.setItem('secondary', secondary);
  }, [secondary]);

  function savePixel(next) {
    const updated = { ...pixel, ...next };
    setPixel(updated);
    localStorage.setItem('ogenotes-pixel-strip-settings', JSON.stringify(updated));
    window.dispatchEvent(new Event('ogenotes-pixel-settings'));
    window.dispatchEvent(new Event('storage'));
  }

  async function addSubject(event) {
    event.preventDefault();
    if (subjectBusy) return;
    setSubjectBusy(true);
    setSubjectMessage('');
    try {
      const subject = await responseJson(await fetch('/api/subjects', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: subjectName }),
      }));
      setSubjects((current) => [...current, subject]);
      setSubjectName('');
      setSubjectMessage('Subject added.');
    } catch (error) { setSubjectMessage(error.message); }
    finally { setSubjectBusy(false); }
  }

  async function removeSubject(subject) {
    if (deleting) return;
    if (subjects.length <= 1) {
      setSubjectMessage('Keep at least one subject in your workspace. Add another before deleting this one.');
      return;
    }
    if (!window.confirm('Delete "' + subject.name + '" and all notes inside it? This cannot be undone.')) return;
    setDeleting(subject.slug);
    setSubjectMessage('');
    try {
      await responseJson(await fetch('/api/subjects?slug=' + encodeURIComponent(subject.slug), { method: 'DELETE' }));
      setSubjects((current) => current.filter((item) => item.slug !== subject.slug));
      setSubjectMessage('Subject and its notes deleted.');
    } catch (error) { setSubjectMessage(error.message); }
    finally { setDeleting(''); }
  }


  async function manageGeminiKey(action) {
    if (geminiBusy) return;
    if (action === 'delete' && !window.confirm('Remove your saved Gemini API key? Gemini clean up will stop working until you add another key.')) return;
    setGeminiBusy(true);
    setGeminiMessage('');
    try {
      const result = await responseJson(await fetch('/api/gemini-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ action, ...(action === 'delete' ? {} : { apiKey: geminiKey }) }),
      }));
      setGeminiMessage(result.message || 'Gemini settings updated.');
      setGeminiMessageType('status');
      if (action === 'save') {
        setGeminiConfigured(true);
        setGeminiUpdatedAt(result.updatedAt || new Date().toISOString());
        setGeminiKey('');
      } else if (action === 'delete') {
        setGeminiConfigured(false);
        setGeminiUpdatedAt(null);
        setGeminiKey('');
      }
    } catch (error) {
      setGeminiMessage(error.message || 'Could not update Gemini settings.');
      setGeminiMessageType('alert');
    } finally {
      setGeminiBusy(false);
    }
  }

  async function restoreBackup(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || backupBusy) return;
    if (file.size > 10 * 1024 * 1024) { setBackupMessage('Backup files must be 10 MB or smaller.'); return; }
    if (!window.confirm('Restore data from this backup? Existing records will be kept where possible.')) return;
    setBackupBusy(true);
    setBackupMessage('');
    try {
      const raw = await file.text();
      const parsed = JSON.parse(raw);
      if (parsed?.format !== 'oge-notes-backup' || parsed?.version !== 1) throw new Error('This is not a supported OgeNotes backup file.');
      const result = await responseJson(await fetch('/api/backup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', body: raw,
      }));
      await refreshSubjects();
      setBackupMessage('Restore complete: ' + result.subjectsAdded + ' subjects, ' + result.notesAdded + ' notes, ' + result.savedLinksAdded + ' saved links, and ' + result.quickNotesAdded + ' quick notes added. Existing records skipped: ' + result.skipped + '.');
    } catch (error) { setBackupMessage(error instanceof SyntaxError ? 'That file is not valid JSON.' : error.message || 'Restore failed.'); }
    finally { setBackupBusy(false); }
  }

  useEffect(() => {
    const openRestore = () => fileRef.current?.click();
    window.addEventListener('oge-open-backup-restore', openRestore);
    return () => window.removeEventListener('oge-open-backup-restore', openRestore);
  }, []);

  return (
    <>
      <section className="oge-settings-card" id="organization" aria-labelledby="organization-heading">
        <div className="oge-settings-card-heading"><div><span className="oge-section-kicker">02 · ORGANIZATION</span><h2 id="organization-heading">Subjects</h2></div><span className="oge-settings-count">{subjects.length} total</span></div>
        <p className="oge-settings-description">Organize your study notes into subjects. Removing a subject also removes the notes inside it.</p>
        <form className="oge-settings-add-form" onSubmit={addSubject}>
          <label className="sr-only" htmlFor="settings-new-subject">New subject name</label>
          <input id="settings-new-subject" value={subjectName} maxLength={60} onChange={(event) => setSubjectName(event.target.value)} placeholder="e.g. Computer Networks" required />
          <button className="oge-google-button" type="submit" disabled={subjectBusy}>{subjectBusy ? 'Adding…' : '+ Add subject'}</button>
        </form>
        {subjectMessage && <p className="oge-settings-feedback" role="status">{subjectMessage}</p>}
        <div className="oge-settings-subjects">
          {subjectLoading ? <p className="oge-settings-note">Loading subjects…</p> : subjects.length ? subjects.map((subject) => (
            <article className="oge-settings-subject" key={subject.slug}>
              <span className="oge-settings-subject-icon" aria-hidden="true">▤</span>
              <div className="oge-settings-subject-copy"><strong>{subject.name}</strong><span>Study notes and revisions</span></div>
              <a href={'/notes?subject=' + encodeURIComponent(subject.slug)} className="oge-settings-open">Open <span aria-hidden="true">↗</span></a>
              <button type="button" className="oge-settings-delete" onClick={() => removeSubject(subject)} disabled={Boolean(deleting)}>{deleting === subject.slug ? 'Deleting…' : 'Delete'}</button>
            </article>
          )) : <p className="oge-settings-note">No subjects yet. Add one to start organizing your notes.</p>}
        </div>
      </section>

      <section className="oge-settings-card" id="appearance" aria-labelledby="appearance-heading">
        <div className="oge-settings-card-heading"><div><span className="oge-section-kicker">03 · COMFORT</span><h2 id="appearance-heading">Appearance</h2></div></div>
        <p className="oge-settings-description">Preferences are saved in this browser and applied across OgeNotes on this device.</p>
        <div className="oge-settings-control-row"><div><strong>Color mode</strong><span>Choose a light or dark workspace.</span></div><div className="oge-settings-segmented"><button type="button" className={theme === 'light' ? 'is-selected' : ''} aria-pressed={theme === 'light'} onClick={() => setTheme('light')}>☼ Light</button><button type="button" className={theme === 'dark' ? 'is-selected' : ''} aria-pressed={theme === 'dark'} onClick={() => setTheme('dark')}>◐ Dark</button></div></div>
        <div className="oge-settings-control-block"><strong>Primary accent</strong><span>Used for active states and key actions.</span><div className="oge-settings-swatches">{ACCENTS.map((item) => <button key={item.id} type="button" className={'oge-settings-swatch ' + (accent === item.id ? 'is-selected' : '')} onClick={() => setAccent(item.id)} aria-pressed={accent === item.id} aria-label={item.label + ' primary accent'}><i style={{ background: item.color }} />{item.label}</button>)}</div></div>
        <div className="oge-settings-control-block"><strong>Secondary accent</strong><span>Use a complementary color for supporting details.</span><div className="oge-settings-swatches">{ACCENTS.map((item) => <button key={item.id} type="button" className={'oge-settings-swatch ' + (secondary === item.id ? 'is-selected' : '')} onClick={() => setSecondary(item.id)} aria-pressed={secondary === item.id} aria-label={item.label + ' secondary accent'}><i style={{ background: item.color }} />{item.label}</button>)}</div></div>
      </section>


      <section className="oge-settings-card oge-gemini-settings" id="gemini-ai" aria-labelledby="gemini-ai-heading">
        <div className="oge-settings-card-heading">
          <div><span className="oge-section-kicker">04 · AI TOOLS</span><h2 id="gemini-ai-heading">Gemini AI</h2></div>
          <span className={geminiConfigured ? 'oge-settings-pill' : 'oge-settings-count'}>{geminiConfigured ? 'Key connected' : 'BYOK · Optional'}</span>
        </div>
        <p className="oge-settings-description">Bring your own Google Gemini API key to clean up note headings, grammar, explanations, and Markdown formatting. Gemini suggests edits in your editor; it never overwrites a saved note automatically.</p>
        <div className="oge-gemini-security-note"><strong>Private by design</strong><span>Your key is encrypted before it is stored in your account record. It is never sent to the browser after saving, and it is only used by OgeNotes server routes to call Gemini when you request an edit.</span></div>
        <form className="oge-gemini-key-form" onSubmit={(event) => { event.preventDefault(); manageGeminiKey('save'); }}>
          <label htmlFor="gemini-api-key">Google Gemini API key</label>
          <input id="gemini-api-key" type="password" value={geminiKey} onChange={(event) => setGeminiKey(event.target.value)} placeholder={geminiConfigured ? 'Saved key is hidden — enter a new key to replace it' : 'Paste your Gemini API key'} autoComplete="new-password" spellCheck="false" maxLength={512} />
          <p className="oge-settings-note">Create a key in <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer">Google AI Studio ↗</a>. OgeNotes uses free-tier Gemini models with automatic fallback when a model is unavailable or its quota is exhausted. Free-tier rate limits apply; paid models are not selected.</p>
          <div className="oge-gemini-key-actions">
            <button className="oge-google-button" type="submit" disabled={geminiBusy || !geminiKey.trim()}>{geminiBusy ? 'Working…' : geminiConfigured ? 'Test & replace key' : 'Test & save key'}</button>
            <button className="oge-settings-secondary-button" type="button" onClick={() => manageGeminiKey('test')} disabled={geminiBusy || !geminiKey.trim()}>{geminiBusy ? 'Checking…' : 'Test only'}</button>
            {geminiConfigured && <button className="oge-settings-danger-button" type="button" onClick={() => manageGeminiKey('delete')} disabled={geminiBusy}>Remove key</button>}
          </div>
        </form>
        {geminiConfigured && <p className="oge-settings-note">A key is saved for this account{geminiUpdatedAt ? ' · last updated ' + new Date(geminiUpdatedAt).toLocaleString() : ''}. For safety, the saved value cannot be viewed again.</p>}
        {geminiMessage && <p className="oge-settings-feedback" role={geminiMessageType} aria-live="polite">{geminiMessage}</p>}
      </section>

      <section className="oge-settings-card" id="pixel-strip" aria-labelledby="pixel-heading">
        <div className="oge-settings-card-heading"><div><span className="oge-section-kicker">04 · PERSONALIZATION</span><h2 id="pixel-heading">Pixel Strip</h2></div><span className="oge-settings-pill">Optional</span></div>
        <p className="oge-settings-description">Customize the animated pixel display below the navigation. These controls respect your device’s reduced-motion preference.</p>
        <label className="oge-settings-control-row"><div><strong>Show Pixel Strip</strong><span>Turn the animation on or off throughout the app.</span></div><input className="oge-settings-checkbox" type="checkbox" checked={pixel.enabled} onChange={(event) => savePixel({ enabled: event.target.checked })} /></label>
        <label className="oge-settings-control-row"><div><strong>Pixel color</strong><span>Follow your accent color or use white.</span></div><select value={pixel.color} onChange={(event) => savePixel({ color: event.target.value })}><option value="accent">Theme accent</option><option value="white">Monochrome white</option></select></label>
        <label className="oge-settings-control-row"><div><strong>Animation style</strong><span>Choose a favorite or rotate effects automatically.</span></div><select value={pixel.mode} onChange={(event) => savePixel({ mode: event.target.value })}>{PIXEL_MODES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="oge-settings-control-row"><div><strong>Animation speed</strong><span>Slower motion can feel calmer.</span></div><select value={pixel.speed} onChange={(event) => savePixel({ speed: event.target.value })}><option value="slow">Slow</option><option value="normal">Normal</option><option value="fast">Fast</option></select></label>
        <label className="oge-settings-control-row"><div><strong>Pixel density</strong><span>Choose finer or bolder pixels.</span></div><select value={pixel.density} onChange={(event) => savePixel({ density: event.target.value })}><option value="fine">Fine</option><option value="normal">Balanced</option><option value="bold">Bold</option></select></label>
        <div className="oge-settings-bottom-row"><button type="button" className="oge-settings-secondary-button" onClick={() => window.dispatchEvent(new Event('ogenotes-pixel-preview'))} disabled={!pixel.enabled}>↻ Preview another animation</button><span className="oge-settings-note">Saved automatically on this device.</span></div>
      </section>

      <section className="oge-settings-card" id="data" aria-labelledby="backup-heading">
        <div className="oge-settings-card-heading"><div><span className="oge-section-kicker">05 · RECOVERY</span><h2 id="backup-heading">Backup & restore</h2></div></div>
        <p className="oge-settings-description">Export your subjects, notes, Quick Notes, Saved Links, and news preferences as a JSON file. Keep a backup somewhere private.</p>
        <div className="oge-settings-data-actions"><a className="oge-settings-secondary-link" href="/api/backup">↓ Download backup</a><button className="oge-settings-secondary-button" type="button" onClick={() => fileRef.current?.click()} disabled={backupBusy}>{backupBusy ? 'Restoring…' : 'Restore from backup ↑'}</button><input ref={fileRef} className="oge-settings-file-input" type="file" accept="application/json,.json" onChange={restoreBackup} aria-label="Choose an OgeNotes backup file" /></div>
        {backupMessage && <p className="oge-settings-feedback" role="status" aria-live="polite">{backupMessage}</p>}
        <p className="oge-settings-note">Restore adds missing records and skips duplicates. It does not delete existing records. Maximum backup size: 10 MB.</p>
      </section>
    </>
  );
}
