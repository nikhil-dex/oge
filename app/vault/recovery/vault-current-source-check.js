'use client';

import { useRef, useState } from 'react';
import {
  inspectVaultCurrentResourceFileAndSource,
} from '../../../lib/oge-vault-current-resource-source-check-browser.js';
import styles from './recovery-center.module.css';

/**
 * E21/M89: Independent live CURRENT GitHub source comparison.
 *
 * This is a DIFFERENT, separately opted-in picker from the M88
 * entirely offline check. No user-selected URL, file body upload,
 * archive blob, secrets, note titles or IDs are ever transmitted.
 * Browser requires local M88 digest/schema verification first.
 */
export default function VaultCurrentSourceCheck() {
  const busy = useRef(false);
  const [working, setWorking] = useState(false);
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');

  async function compareFile(event) {
    const file = event.currentTarget.files?.[0] ?? null;
    event.currentTarget.value = '';
    if (!file || busy.current) return;
    busy.current = true;
    setWorking(true);
    setReport(null);
    setError('');
    try {
      const verified = await inspectVaultCurrentResourceFileAndSource(file);
      // Keep no user-selected File, identifiers or digests in React state.
      setReport({
        matched: verified.source.matched,
        totalNotes: verified.local.totalNotes,
        totalQuickNotes: verified.local.totalQuickNotes,
        totalAirNotes: verified.local.totalAirNotes,
      });
    } catch {
      setReport(null);
      setError('Could not compare this backup with your current private GitHub Vault. Local validation, your session, GitHub availability, or the staging safety checks may have failed. No restore or write was attempted.');
    } finally {
      busy.current = false;
      setWorking(false);
    }
  }

  return (
    <div className={styles.localChecker}>
      <p className="oge-settings-description">
        Optional live read-only comparison: select the downloaded backup
        again. Your browser first validates the complete file locally.
        Only its SHA-256 fingerprints, Git snapshot/tree identifiers and
        three resource counts are sent to this site's authenticated server.
        <strong> No private Note text or full backup file is uploaded.</strong>
      </p>
      <label className={styles.localFileLabel} htmlFor="vault-source-check-file">
        Compare existing JSON backup with current private GitHub
      </label>
      <input className={styles.localFileInput} id="vault-source-check-file"
        type="file" accept=".json,application/json"
        disabled={working} onChange={compareFile}/>
      <p className={styles.localHelper}>
        The server reads your current committed private GitHub snapshot
        using a scoped GitHub App read token. It does not access historical
        versions. A backup created before subsequent edits can differ
        without being corrupt. This check is limited to three requests
        per signed-in owner per hour in staging.
      </p>
      {working && <p role="status" className={styles.localStatus}>
        Validating locally, then checking the authenticated current GitHub snapshot…
      </p>}
      {error && <p role="alert" className={styles.localError}>{error}</p>}
      {report && <div role="status" className={styles.localResult}>
        <p><strong>{report.matched
          ? 'Current private GitHub snapshot matches this backup.'
          : 'Current private GitHub snapshot differs from this backup.'}</strong></p>
        <p>Locally checked Notes: {report.totalNotes}
          {' '}· Quick Notes: {report.totalQuickNotes}
          {' '}· AirNotes: {report.totalAirNotes}</p>
        <p>{report.matched
          ? 'The authenticated server independently re-read and hashed the current committed GitHub contents. This verifies a match at the time of inspection, not a permanent source signature.'
          : 'The repository may have changed since this backup was downloaded. A mismatch does not prove the file is damaged; it is not authenticated as the current snapshot.'}</p>
        <p>No restore, import, automatic retry or quarantine release is available here.
          Encrypted drafts, old revisions and Learning Tracks are not covered.</p>
      </div>}
    </div>
  );
}
