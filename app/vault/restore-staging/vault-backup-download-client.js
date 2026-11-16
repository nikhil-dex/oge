'use client';

import { useEffect, useRef, useState } from 'react';
import {
  createVaultBrowserChunkDownloadVerifier,
  readLimitedVaultBrowserExportResponse,
  vaultBrowserChunkExportURL,
} from '../../../lib/oge-vault-browser-chunk-export.js';
import styles from './restore-staging.module.css';

/**
 * Owner-initiated bounded Notes-only backup export.
 * Nothing persists in MongoDB or in browser storage. Each response is
 * verified before its Blob is offered as a numbered local JSON file.
 * Browsers can block automatic multiple downloads: the UI NEVER assumes
 * that successful save dialogs/disk persistence have been confirmed.
 */
export default function VaultBackupDownloadClient({ enabled }) {
  const [attempted, setAttempted] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ parts: 0, notes: 0 });
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');
  const abortRef = useRef(null);
  const downloadsRef = useRef(new Set());

  useEffect(() => () => {
    abortRef.current?.abort();
    for (const url of downloadsRef.current) URL.revokeObjectURL(url);
    // Snapshot local refs for cleanup; no persistent browser store exists.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function downloadBackup() {
    if (!enabled || attempted || running) return;
    setAttempted(true);
    setRunning(true);
    setError('');
    setReport(null);
    const abort = new AbortController();
    abortRef.current = abort;
    const verifier = createVaultBrowserChunkDownloadVerifier();
    let cursor = null;
    let completed = false;

    try {
      for (let index = 1; index <= 16; index++) {
        // First request is CURRENT HEAD; all later requests carry only
        // the server-proven immutable snapshot and prior note cursor.
        const response = await fetch(vaultBrowserChunkExportURL(cursor), {
          method: 'GET', cache: 'no-store', credentials: 'same-origin',
          headers: { Accept: 'application/json' },
          signal: abort.signal,
        });
        const { chunk, text } = await readLimitedVaultBrowserExportResponse(
          response);
        const accepted = await verifier.accept(chunk);
        if (accepted.partNumber !== index) throw new TypeError('Chunk order changed');

        // Provide only verified data as a numbered private file. No note
        // content in log/error/status; no archive upload, localStorage or DB.
        const blob = new Blob([text], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        downloadsRef.current.add(url);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'part-' + String(index).padStart(4, '0') + '.json';
        link.style.display = 'none';
        document.body.appendChild(link);
        try { link.click(); } finally { link.remove(); }
        // Revoke after the browser has had time to initiate download; the
        // original Blob never persists in application/IndexedDB storage.
        setTimeout(() => {
          URL.revokeObjectURL(url);
          downloadsRef.current.delete(url);
        }, 60_000);
        setProgress({
          parts: accepted.partNumber, notes: accepted.notesReceived,
        });

        if (accepted.complete) {
          const complete = await verifier.finish();
          completed = true;
          setReport(complete);
          break;
        }
        cursor = {
          snapshot: accepted.snapshot,
          nextAfterId: accepted.nextAfterId,
        };
      }
      // A missing final page or >16 pages cannot count as complete.
      // This is also guarded by verifier.finish() above.
      if (abort.signal.aborted || !completed)
        throw new TypeError('Export was cancelled or incomplete');
      // Even with complete server response verification, browser save
      // permission can fail: the local file-review picker checks actual files.
    } catch {
      setReport(null);
      setError('Export stopped: the private snapshot may have changed, the provider may have refused a request, or a chunk failed verification. Do not mix partial files with any new backup. Delete incomplete parts and start a fresh reviewed session. No request was automatically retried.');
    } finally {
      setRunning(false);
      if (abortRef.current === abort) abortRef.current = null;
    }
  }

  return (
    <section className={styles.panel} aria-labelledby="vault-backup-export-heading">
      <span className={styles.kicker}>00 / PRIVATE SOURCE DOWNLOAD</span>
      <h2 id="vault-backup-export-heading">Download current GitHub Notes backup</h2>
      <p className={styles.helper}>
        Save a complete set of numbered JSON chunks while your original
        private Vault still contains the Notes. Every downloaded part
        contains readable private note content: use a trusted device,
        protected browser and encrypted private storage.
      </p>
      <p className={styles.helper}>
        The server verifies the signed GitHub owner and current HEAD
        on every part. This browser additionally checks each chunk and
        the complete Notes inventory. A changed HEAD, missing page,
        rate limit or integrity failure stops the download; existing
        partial files must not be treated as a complete backup.
      </p>
      {!enabled ? (
        <p role="status" className={styles.alert}>
          The separate read-only chunk export feature is disabled in
          this staging environment. No download is available.
        </p>
      ) : (
        <>
          <button type="button" className={styles.primary}
            disabled={running || attempted} onClick={downloadBackup}>
            {running ? 'Checking and requesting private files…' :
              attempted ? 'Export attempted in this session' :
                'Download private Notes chunks'}
          </button>
          {running && <button type="button" className={styles.secondary}
            onClick={() => abortRef.current?.abort()}>
            Stop this export
          </button>}
          {attempted && <p role="status" className={styles.muted}>
            {progress.parts} chunk response(s) verified and offered to your
            browser; {progress.notes} Notes inspected. This is not
            confirmation that your browser saved every file.
          </p>}
          {error && <p role="alert" className={styles.alert}>{error}</p>}
          {report && <p role="status" className={styles.neutral}>
            Complete current-Notes sequence verified: {report.partsVerified}
            {' '}parts, {report.notesVerified} Notes. The browser may
            have blocked or asked permission for multiple downloads.
            Confirm that every numbered file was saved, then choose the
            complete set in the local integrity review below.
            This does not include revisions, Quick Notes, AirNotes or
            unsaved encrypted drafts.
          </p>}
        </>
      )}
      <p className={styles.muted}>
        No automatic retry or background backup. After any failed or
        cancelled attempt, start a new review session and make sure
        partial previous downloads are not mixed with the new snapshot.
        Downloaded local files require the separate GitHub-source
        authenticity check before any restore.
      </p>
    </section>
  );
}
