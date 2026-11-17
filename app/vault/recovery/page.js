import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { auth } from '../../../auth.js';
import { getDatabase } from '../../../lib/mongodb.js';
import { ownerMutationFilter } from '../../../lib/active-owner-mutation.js';
import {
  buildVaultRecoveryCenterModel,
  vaultRecoveryCenterStagingAllowed,
} from '../../../lib/oge-vault-recovery-center.js';
import SiteNavbar from '../../components/site-navbar.js';
import VaultCurrentBackupLocalCheck from './vault-current-backup-local-check.js';
import VaultCurrentSourceCheck from './vault-current-source-check.js';
import VaultRestorePreview from './vault-restore-preview.js';
import { vaultCurrentResourceSourceCheckAllowed } from '../../../lib/oge-vault-current-resource-source-verify.js';
import styles from './recovery-center.module.css';

export const metadata = {
  title: 'Vault Recovery Center — Staging Preview',
  robots: { index: false, follow: false },
};
export const dynamic = 'force-dynamic';

/**
 * E19/M87: owner-authenticated, disposable staging ONLY, INFORMATIONAL
 * recovery overview. No restore/import API, archive upload, GitHub write,
 * Notes body, draft body, release lock, retry, or untrusted actor controls.
 *
 * This page does not turn any backup/export flag on or assert that a
 * generated backup has been downloaded or cryptographically verified.
 */
export default async function VaultRecoveryCenterPage() {
  if (!vaultRecoveryCenterStagingAllowed(process.env)) notFound();

  const session = await auth();
  if (!session?.user?.id) redirect('/register');
  const db = await getDatabase();
  const owner = await db.collection('users').findOne({
    ...ownerMutationFilter(session.user.id, {
      sessionVersion: session.user.sessionVersion,
    }),
    'vault.status': 'connected',
    'vault.repoName': 'ogenotes-vault',
  }, { projection: { _id: 1 } });
  if (!owner) notFound();

  const model = buildVaultRecoveryCenterModel(process.env);
  const sourceCompareEnabled = vaultCurrentResourceSourceCheckAllowed(process.env);

  return (
    <main className={'shell oge-shell oge-retro-workspace ' + styles.page}>
      <SiteNavbar actions={
        <Link className="oge-signin" href="/vault">
          Back to private Vault →
        </Link>
      } />
      <div className="oge-retro-workspace-ribbon" aria-hidden="true">
        <span>✳ OGE / PRIVATE ARCHIVE</span>
        <span>STAGING PREVIEW · INFORMATION ONLY</span>
      </div>
      <section className="oge-settings-hero">
        <p className="oge-eyebrow">
          <span className="oge-status-dot" /> PRIVATE VAULT · RECOVERY
        </p>
        <h1>Recovery Center<span>.</span></h1>
        <p>See exactly what a current GitHub Vault backup can include,
          what it leaves out, and which recovery actions are not yet available.
          This screen never changes your notes.</p>
      </section>
      <section className="oge-settings-card oge-vault-card" aria-labelledby="backup-heading">
        <div className="oge-settings-card-heading">
          <div>
            <span className="oge-section-kicker">01 · BACKUP COVERAGE</span>
            <h2 id="backup-heading">Committed resource snapshot</h2>
          </div>
          <span className="oge-settings-pill">Staging preview</span>
        </div>
        <p className="oge-settings-description">
          A download, when enabled, is generated from your private GitHub Vault
          at the time of the request. This page does not inspect the actual files.
        </p>
        <ul className={styles.resources}>
          {model.resources.map(item => (
            <li key={item.key} className={styles.resource}>
              <span className={styles.resourceMark} aria-hidden="true">✓</span>
              <span><strong>{item.label}</strong>
                <small>{item.coverage}</small></span>
              <span className={styles.chip}>Committed only</span>
            </li>
          ))}
        </ul>
        {model.backupRequestEnabled ? (
          <>
            <p className="oge-settings-note">
              The downloaded archive contains plaintext committed Notes,
              Quick Notes and AirNotes. Keep it in a private, encrypted
              location. Verify the file after download; it is not a
              complete account backup and cannot be imported here.
            </p>
            <a className="oge-primary-link"
              href="/api/vault/backup-current-resources"
              download="oge-vault-current-resources.json">
              Request current Vault snapshot ↓
            </a>
          </>
        ) : (
          <p role="status" className="oge-settings-note">
            Current-resource backup download is disabled in this staging
            environment. No backup has been requested.
          </p>
        )}
      </section>
      <section className="oge-settings-card oge-vault-card"
        aria-labelledby="local-check-heading">
        <div className="oge-settings-card-heading">
          <div>
            <span className="oge-section-kicker">02 · VERIFY LOCALLY</span>
            <h2 id="local-check-heading">Check a downloaded backup</h2>
          </div>
          <span className="oge-settings-pill">No upload</span>
        </div>
        <VaultCurrentBackupLocalCheck />
      </section>
      <section className="oge-settings-card oge-vault-card"
        aria-labelledby="source-check-heading">
        <div className="oge-settings-card-heading">
          <div>
            <span className="oge-section-kicker">03 · PRIVATE GITHUB SOURCE</span>
            <h2 id="source-check-heading">Compare against current GitHub</h2>
          </div>
          <span className="oge-settings-pill">Read-only · opt-in</span>
        </div>
        {sourceCompareEnabled
          ? <VaultCurrentSourceCheck />
          : <p role="status" className="oge-settings-note">
              Live private GitHub source comparison is disabled in this
              staging environment. Local backup verification above
              remains available without any network request.
            </p>}
      </section>
      <section className="oge-settings-card oge-vault-card"
        aria-labelledby="restore-preview-heading">
        <div className="oge-settings-card-heading">
          <div>
            <span className="oge-section-kicker">04 · RESTORATION PREVIEW</span>
            <h2 id="restore-preview-heading">Inspect possible conflicts</h2>
          </div>
          <span className="oge-settings-pill">Local-only · no restore</span>
        </div>
        <VaultRestorePreview />
      </section>
      <section className="oge-settings-card oge-vault-card"
        aria-labelledby="excluded-heading">
        <div className="oge-settings-card-heading">
          <div>
            <span className="oge-section-kicker">05 · NOT INCLUDED</span>
            <h2 id="excluded-heading">Outside this snapshot</h2>
          </div>
          <span className="oge-settings-pill">Not backed up here</span>
        </div>
        <ul className={styles.exclusions}>
          {model.exclusions.map(item => (
            <li key={item.key}>
              <span aria-hidden="true">—</span>
              <span>{item.label}</span>
              <strong>Excluded</strong>
            </li>
          ))}
        </ul>
        <p className="oge-settings-note">
          Existing temporary drafts and older history must be handled
          separately before a complete account recovery can be promised.
          The absence of content from this snapshot is not proof that
          it has been safely preserved elsewhere.
        </p>
      </section>
      <section className="oge-settings-card oge-vault-card"
        aria-labelledby="safety-heading">
        <div className="oge-settings-card-heading">
          <div>
            <span className="oge-section-kicker">06 · SAFETY STATUS</span>
            <h2 id="safety-heading">Recovery is not yet enabled</h2>
          </div>
          <span className="oge-settings-pill">Review pending</span>
        </div>
        <div className={styles.safeguards}>
          <p>Actual GitHub OAuth and two-device staging acceptance: <strong>Pending</strong></p>
          <p>Live provider failure and lost-write tests: <strong>Pending</strong></p>
          <p>Source archive identity and full account recovery: <strong>Pending</strong></p>
          <p>Post-write quarantine release: <strong>Not available</strong></p>
        </div>
        <p className="oge-settings-note">
          An uncertain GitHub write remains quarantined until separately
          reviewed by authorized operators. This page never unlocks,
          retries, restores or deletes any private note.
        </p>
      </section>
      <p className={styles.footnote}>
        This is a private staging-only information screen, not proof that a
        backup exists or an approval to perform restoration.
      </p>
    </main>
  );
}
