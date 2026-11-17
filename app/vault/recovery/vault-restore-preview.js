'use client';

import { useRef, useState } from 'react';
import { previewVaultRecoveryFiles } from '../../../lib/oge-vault-restore-preview.js';
import { previewVaultHistoricallyAuthenticatedRecoveryFiles } from '../../../lib/oge-vault-historical-restore-preview.js';
import {
  previewVaultAuthenticatedRecoveryFiles,
} from '../../../lib/oge-vault-authenticated-restore-preview.js';
import styles from './recovery-center.module.css';

/**
 * E23/M91: two EXPLICIT single-file inputs avoid browser ordering ambiguity.
 * When authenticated mode is enabled by signed isolated staging, the
 * reference MUST match the private GitHub current HEAD via M89 before any
 * authoritative-at-inspection comparison is displayed. No restore writes.
 */
export default function VaultRestorePreview({
  authenticateCurrent = false, authenticateHistory = false,
}) {
  const backupInput = useRef(null);
  const currentInput = useRef(null);
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');

  async function check() {
    if (running.current) return;
    // File handles live only in this callback, NOT in component state or refs.
    const backup = backupInput.current?.files?.[0] ?? null;
    const reference = currentInput.current?.files?.[0] ?? null;
    if (backupInput.current) backupInput.current.value = '';
    if (currentInput.current) currentInput.current.value = '';
    if (!backup || !reference) {
      setReport(null);
      setError('Choose both the recovery backup and the separate reference snapshot.');
      return;
    }
    running.current = true;
    setBusy(true);
    setError('');
    setReport(null);
    try {
      const result = authenticateHistory
        ? await previewVaultHistoricallyAuthenticatedRecoveryFiles(backup, reference)
        : authenticateCurrent
          ? await previewVaultAuthenticatedRecoveryFiles(backup, reference)
          : await previewVaultRecoveryFiles([backup, reference]);
      // Store only counts and safety flags, no private bytes or identifiers.
      setReport(result);
    } catch {
      setError('Comparison could not be verified. The files, private GitHub source, signed session or staging gate may have changed. No restoration or write was attempted.');
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  return (
    <div className={styles.localChecker}>
      <p className="oge-settings-description">
        Select the <strong>backup you might recover</strong> and, in the
        separate field below, a <strong>current-resource reference snapshot</strong>.
        Both are verified locally before comparison. This never restores notes.
      </p>
      <label className={styles.localFileLabel}
        htmlFor="vault-restore-backup-file">
        1. Recovery backup to inspect
      </label>
      <input ref={backupInput} className={styles.localFileInput} type="file"
        id="vault-restore-backup-file" accept=".json,application/json"
        disabled={busy} onChange={() => { setReport(null); setError(''); }} />
      <label className={styles.localFileLabel}
        htmlFor="vault-restore-reference-file">
        2. Reference snapshot from the current Vault
      </label>
      <input ref={currentInput} className={styles.localFileInput} type="file"
        id="vault-restore-reference-file" accept=".json,application/json"
        disabled={busy} onChange={() => { setReport(null); setError(''); }} />
      <p className={styles.localHelper}>
        Each JSON file must be at most 8 MiB. No private Note text,
        resource ID, title or file bytes are uploaded.
        {authenticateHistory
          ? ' After both local checks, only fingerprints, Git snapshot identifiers and resource counts are sent separately to the M92 bounded-history and M89 current-source read-only verification endpoints. History supports at most 20 single-parent Git commits.'
          : authenticateCurrent
            ? ' After both local checks, only the reference fingerprint, Git snapshot identifiers and three resource counts are sent to the independently authenticated, rate-limited M89 current GitHub source checker.'
            : ' Offline comparison only: neither backup is independently authenticated to GitHub because live source verification is disabled.'}
      </p>
      <button type="button" className="oge-primary-link" disabled={busy}
        onClick={check}>
        {authenticateHistory
          ? 'Verify private GitHub history and current reference'
          : authenticateCurrent
            ? 'Verify current GitHub reference and preview'
            : 'Compare both files locally'}
      </button>
      {busy && <p role="status" className={styles.localStatus}>
        Checking both archives{authenticateHistory
          ? ', bounded private Git history and current GitHub reference…'
          : authenticateCurrent
            ? ' and authenticating the current GitHub reference…'
            : ' locally…'}
      </p>}
      {error && <p role="alert" className={styles.localError}>{error}</p>}
      {['HISTORICAL_PRIVATE_GITHUB_SOURCE_DIFFERS_HOLD',
        'CURRENT_PRIVATE_GITHUB_SOURCE_DIFFERS_HOLD'].includes(report?.status) && (
        <p role="alert" className={styles.localError}>
          The selected archive could not be matched to the signed private
          GitHub source. It may be outside the bounded history or the
          reference may have changed. No authenticated plan is displayed;
          there is no permission to restore or automatically retry.
        </p>
      )}
      {report?.status === 'CURRENT_GITHUB_REFERENCE_DIFFERED_HOLD' && (
        <p role="alert" className={styles.localError}>
          The chosen reference does not match the owner&apos;s current
          authenticated private GitHub HEAD at inspection time. It may
          simply be an older valid export. No conflict plan or restoration
          authorization was produced. Obtain a fresh backup and retry manually.
        </p>
      )}
      {report?.resources && <div role="status" className={styles.localResult}>
        <p><strong>{report.backupSourceAuthenticated &&
          report.currentSnapshotAuthenticatedAtCheck
          ? 'Historical backup and current reference independently matched private GitHub at inspection time.'
          : report.currentSnapshotAuthenticatedAtCheck
            ? 'Reference matched authenticated current private GitHub at inspection time.'
            : 'Local-only file comparison — reference not source-authenticated.'}</strong></p>
        <p>Would add: <strong>{report.totalAdd}</strong>
          {' '}· Conflicting: <strong>{report.totalConflict}</strong>
          {' '}· Unchanged: <strong>{report.totalUnchanged}</strong>
          {' '}· Current-only preserved: <strong>{report.totalPreserve}</strong>
        </p>
        <ul>
          {report.resources.map(item => (
            <li key={item.key}><strong>{item.label}:</strong>
              {' '}{item.add} additions, {item.conflict} conflicts,
              {' '}{item.unchanged} unchanged, {item.preserve} current-only preserved
            </li>
          ))}
        </ul>
        <p>Conflicts indicate equal resource IDs but different Git blob SHA
          values. {report.backupSourceAuthenticated
            ? 'The candidate archive matched a bounded private historical GitHub commit; this is not proof of a complete account backup.'
            : 'The recovery backup has only local checks, not independently authenticated historical GitHub provenance.'}
          {' '}The current repository may change after inspection, and the
          historical and current checks are not an atomic transaction.</p>
        <p><strong>Still required:</strong> explicit safe conflict decisions,
          stable source-to-target validation, GitHub write quiescence,
          live OAuth and provider-failure acceptance, audited restore controls
          and security signoff. No overwrite, import, automatic retry,
          lock release or restore is authorized.</p>
      </div>}
    </div>
  );
}
