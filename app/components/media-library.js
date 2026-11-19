'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import SiteNavbar from './site-navbar';

async function readResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
  return data;
}

function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Recently added' : date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function MediaLibrary() {
  const [folders, setFolders] = useState([]);
  const [files, setFiles] = useState([]);
  const [folderId, setFolderId] = useState(null);
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [preview, setPreview] = useState(null);
  const uploadRef = useRef(null);
  const pendingUploadsRef = useRef(new Map());

  const loadLibrary = useCallback(async (selectedFolder = null) => {
    setLoading(true);
    setError('');
    try {
      const data = await readResponse(await fetch('/api/vault/media' + (selectedFolder ? '?folderId=' + encodeURIComponent(selectedFolder) : ''), { cache: 'no-store' }));
      setFolders(data.folders || []);
      setFiles(data.files || []);
      setFolderId(data.currentFolderId || null);
    } catch (err) {
      setError(err.message || 'Could not load the file library.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { Promise.resolve().then(() => { void loadLibrary(null); }); }, [loadLibrary]);

  const currentFolder = folders.find((folder) => folder.id === folderId);
  const visibleFolders = useMemo(() => folders.filter((folder) => folder.name.toLowerCase().includes(query.trim().toLowerCase())), [folders, query]);
  const visibleFiles = useMemo(() => files.filter((file) => {
    const matchesQuery = file.name.toLowerCase().includes(query.trim().toLowerCase());
    const matchesType = typeFilter === 'all' || (typeFilter === 'pdf' ? file.type === 'application/pdf' : typeFilter === 'zip' ? file.type === 'application/zip' : file.type.startsWith('image/'));
    return matchesQuery && matchesType;
  }), [files, query, typeFilter]);

  async function createFolder() {
    const name = window.prompt('Folder name');
    if (name === null) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const folder = await readResponse(await fetch('/api/vault/media', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'create-folder', name }) }));
      setFolders((current) => [...current, folder].sort((a, b) => a.name.localeCompare(b.name)));
      setMessage('Folder created.');
    } catch (err) { setError(err.message || 'Could not create the folder.'); }
    finally { setBusy(false); }
  }

  async function renameFolder(folder) {
    const name = window.prompt('New folder name', folder.name);
    if (name === null) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const updated = await readResponse(await fetch('/api/vault/media', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'rename-folder', id: folder.id, name }) }));
      setFolders((current) => current.map((item) => item.id === folder.id ? updated : item));
      setMessage('Folder renamed.');
    } catch (err) { setError(err.message || 'Could not rename the folder.'); }
    finally { setBusy(false); }
  }

  async function deleteFolder(folder) {
    if (!window.confirm(`Delete folder “${folder.name}” and permanently delete all files inside it from private storage? This cannot be undone.`)) return;
    setBusy(true); setError(''); setMessage('');
    try {
      await readResponse(await fetch('/api/vault/media?id=' + encodeURIComponent(folder.id) + '&type=folder', { method: 'DELETE' }));
      setFolders((current) => current.filter((item) => item.id !== folder.id));
      setMessage('Folder deleted.');
    } catch (err) { setError(err.message || 'Could not delete the folder.'); }
    finally { setBusy(false); }
  }

  async function uploadFiles(event) {
    const selected = Array.from(event.target.files || []);
    event.target.value = '';
    if (!selected.length || busy) return;
    setBusy(true); setError(''); setMessage('');
    let uploaded = 0;
    try {
      for (const file of selected) {
        const type = file.name.toLowerCase().endsWith('.zip')
          ? 'application/zip' : (file.type || '');
        const size = file.size;
        if (!size || size > 20 * 1024 * 1024)
          throw new Error('Choose a file between 1 byte and 20 MB.');
        // A lost final HTTP response must not cause a second file ID. Keep
        // completed chunk SHAs until this exact upload is confirmed.
        const fingerprint = [folderId || '', file.name, type, size, file.lastModified].join('|');
        const pending = pendingUploadsRef.current.get(fingerprint) ||
          { id: crypto.randomUUID(), chunks: [] };
        pendingUploadsRef.current.set(fingerprint, pending);
        const id = pending.id;
        const chunks = pending.chunks;
        const chunkSize = 2 * 1024 * 1024;
        const count = Math.ceil(size / chunkSize);
        for (let part = chunks.length; part < count; part++) {
          const piece = file.slice(part * chunkSize, Math.min(size, (part + 1) * chunkSize));
          const result = await readResponse(await fetch('/api/vault/media?action=upload-chunk&id=' +
            encodeURIComponent(id) + '&part=' + part, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: piece,
          }));
          chunks.push({ sha: result.sha, size: result.size });
          setMessage('Uploading ' + file.name + ' · ' + Math.round((part + 1) / count * 100) + '%');
        }
        await readResponse(await fetch('/api/vault/media', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'upload-file', id, name: file.name, type, size, folderId, parts: chunks,
          }),
        }));
        pendingUploadsRef.current.delete(fingerprint);
        uploaded++;
      }
      setMessage(uploaded + ' file' + (uploaded === 1 ? '' : 's') + ' uploaded.');
      await loadLibrary(folderId);
    } catch (err) {
      setError(err.message || 'Upload failed. Files completed before this may already be saved.');
      await loadLibrary(folderId);
    } finally { setBusy(false); }
  }

  async function openPreview(file) {
    setError('');
    try {
      const result = await readResponse(await fetch('/api/vault/media?action=download&id=' + encodeURIComponent(file.id), { cache: 'no-store' }));
      setPreview({ ...file, url: result.url });
    } catch (err) { setError(err.message || 'Could not open this file.'); }
  }

  async function downloadFile(file) {
    setBusy(true); setError('');
    try {
      const result = await readResponse(await fetch('/api/vault/media?action=download&disposition=attachment&id=' + encodeURIComponent(file.id), { cache: 'no-store' }));
      const link = document.createElement('a');
      link.href = result.url;
      link.download = file.name;
      link.rel = 'noopener';
      document.body.appendChild(link); link.click(); link.remove();
      setMessage('Download started through the protected file route.');
    } catch (err) { setError(err.message || 'Could not download this file.'); }
    finally { setBusy(false); }
  }

  async function renameFile(file) {
    const name = window.prompt('New file name (keep the same extension)', file.name);
    if (name === null || name.trim() === file.name) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const updated = await readResponse(await fetch('/api/vault/media', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rename-file', id: file.id, name: name.trim() }),
      }));
      setFiles((current) => current.map((item) => item.id === file.id ? updated : item));
      setPreview((current) => current?.id === file.id ? { ...current, ...updated } : current);
      setMessage('File renamed.');
    } catch (err) { setError(err.message || 'Could not rename the file.'); }
    finally { setBusy(false); }
  }

  async function shareFile(file) {
    setError(''); setMessage('');
    try {
      const result = await readResponse(await fetch('/api/vault/media?action=download&id=' + encodeURIComponent(file.id), { cache: 'no-store' }));
      const url = new URL(result.url, window.location.origin).href;
      if (navigator.share && navigator.canShare) {
        const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
        if (!response.ok) throw new Error('Could not prepare this file for sharing.');
        const blob = await response.blob();
        const sharedFile = new File([blob], file.name, { type: file.type });
        if (navigator.canShare({ files: [sharedFile] })) {
          await navigator.share({ title: file.name, files: [sharedFile] });
          setMessage('Share sheet opened.');
          return;
        }
      }
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        setMessage('Private file link copied. It works for people who have access to your OgeNotes session.');
      } else {
        window.prompt('Copy this private file link. It requires your OgeNotes access session:', url);
      }
    } catch (err) {
      if (err?.name === 'AbortError') return;
      setError(err.message || 'Could not share this file.');
    }
  }

  async function moveFile(file) {
    const choices = [{ id: '', name: 'Library root' }, ...folders.filter((folder) => folder.id !== folderId)];
    const promptText = 'Move to:\n' + choices.map((choice, index) => `${index + 1}. ${choice.name}`).join('\n') + '\nEnter a number';
    const answer = window.prompt(promptText, '1');
    if (answer === null) return;
    const index = Number(answer) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= choices.length) { setError('Choose a valid destination number.'); return; }
    setBusy(true); setError(''); setMessage('');
    try {
      await readResponse(await fetch('/api/vault/media', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'move-file', id: file.id, folderId: choices[index].id || null }) }));
      setFiles((current) => current.filter((item) => item.id !== file.id));
      setMessage('File moved to ' + choices[index].name + '.');
    } catch (err) { setError(err.message || 'Could not move the file.'); }
    finally { setBusy(false); }
  }

  async function deleteFile(file) {
    if (!window.confirm(`Delete “${file.name}” from private storage? This cannot be undone.`)) return;
    setBusy(true); setError(''); setMessage('');
    try {
      await readResponse(await fetch('/api/vault/media?id=' + encodeURIComponent(file.id), { method: 'DELETE' }));
      setFiles((current) => current.filter((item) => item.id !== file.id));
      if (preview?.id === file.id) setPreview(null);
      setMessage('File deleted.');
    } catch (err) { setError(err.message || 'Could not delete the file.'); }
    finally { setBusy(false); }
  }

  return (
    <>
      <SiteNavbar showFiles notesHref="/vault/notes" />
      <section className="media-hero">
        <p className="eyebrow">PRIVATE RESOURCE SPACE</p>
        <div className="media-title-row"><div><h1>My Files<span className="period">.</span></h1><p className="hub-lead">Keep images, PDFs, and ZIP archives organized in private folders.</p></div><span className="media-private-pill">♢ Private storage</span></div>
      </section>

      <section className="media-workspace" aria-label="Image and PDF library">
        <div className="media-toolbar">
          <div className="media-search"><span aria-hidden="true">⌕</span><input aria-label="Search files and folders" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search this folder…" /></div>
          <div className="media-toolbar-actions">
            <button className="study-button" type="button" disabled={busy} onClick={createFolder}>＋ Folder</button>
            <button className="add-button" type="button" disabled={busy} onClick={() => uploadRef.current?.click()}>↑ Upload files</button>
            <input ref={uploadRef} className="media-hidden-input" type="file" accept=".pdf,.zip,.jpg,.jpeg,.png,.webp,application/pdf,application/zip,image/jpeg,image/png,image/webp" multiple onChange={uploadFiles} />
          </div>
        </div>
        <div className="media-breadcrumbs"><button type="button" onClick={() => loadLibrary(null)}>My Files</button>{currentFolder && <><span>/</span><strong>{currentFolder.name}</strong></>}</div>
        <div className="media-filter-row"><span>{currentFolder ? 'CURRENT FOLDER' : 'ALL FILES'}</span><div className="media-type-filters">{[['all','All'],['pdf','PDFs'],['zip','ZIPs'],['images','Images']].map(([value,label]) => <button key={value} className={typeFilter === value ? 'active' : ''} type="button" onClick={() => setTypeFilter(value)}>{label}</button>)}</div></div>
        {error && <p className="media-feedback is-error" role="alert">{error}</p>}
        {message && <p className="media-feedback" role="status">{message}</p>}
        {busy && <p className="media-inline-status" role="status">Working… Keep this page open until the operation finishes.</p>}
        {loading ? <p className="media-empty">Loading your private library…</p> : (
          <>
            {!query && visibleFolders.length > 0 && <div className="media-folder-grid">{visibleFolders.map((folder) => <article className="media-folder-card" key={folder.id}><button className="media-folder-open" type="button" onClick={() => loadLibrary(folder.id)}><span className="media-folder-icon">▰</span><strong>{folder.name}</strong><small>Folder</small></button><div className="media-folder-actions"><button type="button" onClick={() => renameFolder(folder)} disabled={busy} aria-label={`Rename ${folder.name}`}>Rename</button><button type="button" onClick={() => deleteFolder(folder)} disabled={busy} aria-label={`Delete ${folder.name}`}>Delete</button></div></article>)}</div>}
            {visibleFiles.length > 0 ? <div className="media-file-grid">{visibleFiles.map((file) => <article className="media-file-card" key={file.id}><button className="media-file-preview" type="button" onClick={() => openPreview(file)} aria-label={`Preview ${file.name}`}>{file.type.startsWith('image/') ? <span className="media-file-image">▧</span> : file.type === 'application/zip' ? <span className="media-file-pdf">ZIP</span> : <span className="media-file-pdf">PDF</span>}</button><div className="media-file-info"><strong title={file.name}>{file.name}</strong><span>{formatBytes(file.size)} · {formatDate(file.updatedAt || file.createdAt)}</span><div className="media-file-actions"><button type="button" onClick={() => openPreview(file)}>Preview</button><button type="button" onClick={() => downloadFile(file)} disabled={busy}>Download</button><button type="button" onClick={() => renameFile(file)} disabled={busy}>Rename</button><button type="button" onClick={() => shareFile(file)} disabled={busy}>Share</button><button type="button" onClick={() => moveFile(file)} disabled={busy}>Move</button><button type="button" onClick={() => deleteFile(file)} disabled={busy}>Delete</button></div></div></article>)}</div> : <div className="media-empty"><span className="media-empty-icon">▧</span><h2>{query ? 'No matches found' : 'Nothing here yet'}</h2><p>{query ? 'Try another filename or clear your search.' : 'Upload an image, PDF, or ZIP archive, or create a folder to get started.'}</p></div>}
          </>
        )}
      </section>
      <footer><span>Keep useful files close at hand.</span><span>OGENOTES · PRIVATE FILE LIBRARY</span></footer>
      {preview && <div className="media-preview-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPreview(null); }}><section className="media-preview-dialog" role="dialog" aria-modal="true" aria-label={`Preview ${preview.name}`}><div className="media-preview-header"><div><strong>{preview.name}</strong><span>{formatBytes(preview.size)}</span></div><div><button type="button" onClick={() => downloadFile(preview)} disabled={busy}>Download</button><button type="button" onClick={() => renameFile(preview)} disabled={busy}>Rename</button><button type="button" onClick={() => shareFile(preview)} disabled={busy}>Share</button><button className="media-preview-close" type="button" onClick={() => setPreview(null)} aria-label="Close preview">×</button></div></div>{preview.type === 'application/pdf' ? <iframe title={preview.name} src={preview.url} className="media-pdf-frame" /> : preview.type === 'application/zip' ? <div className="media-empty"><h2>ZIP archive</h2><p>Download this ZIP to open its contents.</p></div> : <img src={preview.url} alt={preview.name} className="media-image-preview" />}</section></div>}
    </>
  );
}
