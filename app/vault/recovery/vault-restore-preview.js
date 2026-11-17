'use client';

import { useRef, useState } from 'react';
import { previewVaultRecoveryFiles } from '../../../lib/oge-vault-restore-preview.js';
import styles from './recovery-center.module.css';

/** M90: local-only two-file preview; only redacted counts enter React state. */
export default function VaultRestorePreview() {
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');

  async function check(event) {
    const files = Array.from(event.currentTarget.files || []);
    event.currentTarget.value = '';
    if (busyRef.current || files.length === 0) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setReport(null);
    try {
      // File ordering is intentional: archive to preview, then reference.
      // No File, private ID, body, SHA or parsed archive enters React state.
      setReport(await previewVaultRecoveryFiles(files));
    } catch {
      setError('Preview unavailable. Choose exactly two valid current-resource JSON files, ordered backup first and reference snapshot second. Neither file is treated as authenticated GitHub evidence.');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <div className={styles.localChecker}>
      <p className="oge-settings-description">
        Compare two already-downloaded current-resource backups entirely in this
        browser: select the backup you might recover <strong>first</strong>,
        and a separately downloaded reference snapshot <strong>second</strong>.
        Both files must pass independent local SHA-256 verification.
      </p>
      <label className={styles.localFileLabel} htmlFor="vault-restore-preview-files">
        Select backup first and reference snapshot second
      </label>
      <input className={styles.localFileInput} type="file" multiple
        id="vault-restore-preview-files" accept=".json,application/json"
        disabled={busy} onChange={check} />
      <p className={styles.localHelper}>
        Exactly two JSON files, each at most 8 MiB. Your browser may sort
        selected files differently; verify the displayed selection order before
        trusting any comparison. Nothing is uploaded. Local embedded hashes do
        not prove either file is genuinely from the current private GitHub Vault.
      </p>
      {busy && <p role="status" className={styles.localStatus}>
        Checking both files and comparing resources locally…
      </p>}
      {error && <p role="alert" className={styles.localError}>{error}</p>}
      {report && <div role="status" className={styles.localResult}>
        <p><strong>Read-only comparison available — no restore authorization.</strong></p>
        <p>Would add: <strong>{report.totalAdd}</strong>
          {' '}· Conflicting: <strong>{report.totalConflict}</strong>
          {' '}· Unchanged: <strong>{report.totalUnchanged}</strong>
          {' '}· Current-only preserved: <strong>{report.totalPreserve}</strong></p>
        <ul>
          {report.resources.map(item => (
            <li key={item.key}>
              <strong>{item.label}:</strong> {item.add} additions,
              {' '}{item.conflict} conflicts, {item.unchanged} unchanged,
              {' '}{item.preserve} current-only preserved
            </li>
          ))}
        </ul>
        <p>Conflicts mean the same resource ID has different Git blob SHA
          values. This is an illustrative plan, not an authenticated
          merge or overwrite instruction. No deletion is proposed.</p>
        <p><strong>Still required:</strong> authenticated repository/snapshot
          provenance, explicit conflict decisions, isolated restore
          acceptance, provider failure testing, writer quiescence and
          security approval. Restore/import and quarantine release remain disabled.</p>
      </div>}
    </div>
  );
}
