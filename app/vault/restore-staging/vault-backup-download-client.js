'use client';

import { useEffect, useRef, useState } from 'react';
import {
  createVaultBrowserChunkDownloadVerifier,
  readLimitedVaultBrowserExportResponse,
  vaultBrowserChunkExportURL,
} from '../../../lib/oge-vault-browser-chunk-export.js';
import styles from './restore-staging.module.css';
import { createVaultOfflineEncryptSession } from '../../../lib/oge-vault-offline-backup-crypto.js';

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
  const [passphrase, setPassphrase] = useState('');
  const [repeatPassphrase, setRepeatPassphrase] = useState('');
  const abortRef = useRef(null);
  const downloadsRef = useRef(new Set());

  useEffect(() => () => {
    abortRef.current?.abort();
    for (const url of downloadsRef.current) URL.revokeObjectURL(url);
    // Snapshot local refs for cleanup; no persistent browser store exists.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function downloadBackup() {
    if (!enabled || attempted || running ||
        passphrase.length < 16 || passphrase !== repeatPassphrase) return;
    setAttempted(true);
    setRunning(true);
    setError('');
    setReport(null);
    const abort = new AbortController();
    abortRef.current = abort;
    const verifier = createVaultBrowserChunkDownloadVerifier();
    let cursor = null;
    let completed = false;
    let encryptor;

    try {
      // Derive the key before any plaintext chunk leaves the GET response
      // buffer; never offer raw plaintext parts as disk downloads.
      encryptor = await createVaultOfflineEncryptSession(passphrase);
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
        // content in log/error/status; no upload or persistent storage.
        const sealed = await encryptor.seal(text, accepted.partNumber);
        const blob = new Blob([sealed.text], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        downloadsRef.current.add(url);
        const link = document.createElement('a');
        link.href = url;
        link.download = sealed.filename;
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
      encryptor?.close();
      setPassphrase('');
      setRepeatPassphrase('');
      setRunning(false);
      if (abortRef.current === abort) abortRef.current = null;
    }
  }

  return (
    <section className={styles.panel} aria-labelledby="vault-backup-export-heading">
      <span className={styles.kicker}>00 / PRIVATE SOURCE DOWNLOAD</span>
      <h2 id="vault-backup-export-heading">Download current GitHub Notes backup</h2>
      <p className={styles.helper}>
        Download encrypted, numbered Notes-only chunks while your
        original private GitHub Vault still contains them. The browser
        receives plaintext over authenticated HTTPS, verifies it,
        then encrypts each part locally with AES-256-GCM before
        offering it for download. Use a trusted staging device.
      </p>
      <p className={styles.helper}>
        The server verifies the signed GitHub owner and current HEAD
        on every part. This browser also checks the full Notes inventory.
        A moving HEAD, missing part, rate limit or integrity failure
        stops the download. Keep your unique, strong passphrase safe:
        it is not stored or recoverable by Oge, and forgetting it makes
        these encrypted backups unrecoverable.
      </p>
      {!enabled ? (
        <p role="status" className={styles.alert}>
          The separate read-only chunk export feature is disabled in
          this staging environment. No download is available.
        </p>
      ) : (
        <>
          <div className={styles.form}>
            <label>Private backup passphrase (at least 16 characters)
              <input type="password" name="offline-backup-passphrase"
                autoComplete="new-password" minLength={16} maxLength={256}
                value={passphrase} disabled={running || attempted}
                onChange={(event) => setPassphrase(event.target.value)}
                placeholder="Use a long unique passphrase — never share it" />
            </label>
            <label>Repeat private backup passphrase
              <input type="password" name="offline-backup-confirm"
                autoComplete="new-password" minLength={16} maxLength={256}
                value={repeatPassphrase} disabled={running || attempted}
                onChange={(event) => setRepeatPassphrase(event.target.value)}
                placeholder="Confirm your exact passphrase" />
            </label>
          </div>
          <p className={styles.muted}>
            Each downloaded <code>part-0001.oge.json</code> file contains
            authenticated ciphertext, not plaintext note answers.
            Password-based encryption cannot guarantee safety if the
            passphrase is easy to guess or the browser is compromised.
          </p>
          <button type="button" className={styles.primary}
            disabled={running || attempted ||
              passphrase.length < 16 ||
              passphrase !== repeatPassphrase}
            onClick={downloadBackup}>
            {running ? 'Checking and requesting private files…' :
              attempted ? 'Encrypted export attempted in this session' :
                'Download encrypted private Notes chunks'}
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
            {' '}encrypted parts, {report.notesVerified} Notes. Your
            browser may block or request permission for multiple downloads.
            Confirm that every <code>part-NNNN.oge.json</code> file was
            actually saved, then select the complete encrypted set and
            enter the same passphrase in the local review below.
            This does not include revisions, Quick Notes, AirNotes or
            unsaved encrypted drafts.
          </p>}
        </>
      )}
      <p className={styles.muted}>
        No automatic retry, plaintext file download or background backup.
        After a failed or cancelled attempt, start a new review session,
        discard partial encrypted parts and never mix backup sets.
        The separately signed GitHub-source authenticity check is still
        mandatory before any restore.
      </p>
    </section>
  );
}
