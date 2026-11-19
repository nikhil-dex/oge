'use client';

import { useRef, useState } from 'react';
import {
  inspectVaultCurrentResourceFileLocally,
} from '../../../lib/oge-vault-current-resource-local-verify.js';
import styles from './recovery-center.module.css';

/**
 * E20/M88: user-picked local plaintext archive inspected in browser memory.
 * No fetch, form action, server upload, Web Storage, telemetry or restore.
 * Only nonidentifying counters and boolean safety results reach React state.
 */
export default function VaultCurrentBackupLocalCheck() {
  const runningRef = useRef(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  async function inspectFile(event) {
    const file = event.currentTarget.files?.[0] ?? null;
    // Never keep a File object on a long-lived input, React state or ref.
    event.currentTarget.value = '';
    if (!file || runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    setResult(null);
    setError('');
    try {
      const report = await inspectVaultCurrentResourceFileLocally(file);
      setResult(report);
    } catch {
      setResult(null);
      // No parser errors or private file details in status, logs or telemetry.
      setError('The selected file did not pass the local structure and SHA-256 checks. Do not treat it as a safe backup or request restoration.');
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  }

  return (
    <div className={styles.localChecker}>
      <p className="oge-settings-description">
        Select an existing current-resource JSON backup to check its format,
        counts and embedded SHA-256 values entirely on this device. Your
        private Notes are never uploaded or saved by this checker.
      </p>
      <label className={styles.localFileLabel} htmlFor="vault-local-resource-json">
        Choose private backup JSON file
      </label>
      <input className={styles.localFileInput}
        id="vault-local-resource-json"
        type="file" accept=".json,application/json"
        disabled={running} onChange={inspectFile}/>
      <p className={styles.localHelper}>
        Only current-resource JSON files up to 8 MB are supported.
        Use a trusted device: the file contains plaintext Notes.
        Inspection occurs in temporary browser memory; it does not
        securely erase JavaScript copies from memory.
      </p>
      {running && <p role="status" className={styles.localStatus}>
        Checking this local file without uploading it…
      </p>}
      {error && <p role="alert" className={styles.localError}>{error}</p>}
      {result && (
        <div role="status" className={styles.localResult}>
          <p><strong>Local file consistency check passed.</strong></p>
          <p>Notes: <strong>{result.totalNotes}</strong>
            {' '}· Quick Notes: <strong>{result.totalQuickNotes}</strong>
            {' '}· AirNotes: <strong>{result.totalAirNotes}</strong></p>
          <p>Archive and inventory SHA-256 digests match the values
            embedded in this file. This does <strong>not</strong> prove
            that GitHub or your account created it; a forged file can
            carry matching self-declared hashes.</p>
          <p>Historical revisions, unsaved encrypted drafts, legacy
            MongoDB Notes and Learning Tracks progress are excluded.
            This file cannot be restored through this screen.</p>
        </div>
      )}
    </div>
  );
}
