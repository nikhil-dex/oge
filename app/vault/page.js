import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '../../auth.js';
import { getDatabase } from '../../lib/mongodb.js';
import { ownerMutationFilter } from '../../lib/active-owner-mutation.js';
import { vaultConfigured } from '../../lib/oge-vault-github.js';
import { vaultNotesAvailable, vaultCaptureAvailable } from '../../lib/oge-vault-workspace-routing.js';
import { githubVaultFilesEnabled } from '../../lib/oge-vault-media-validation.js';
import { checkVaultStagingReadiness } from '../../lib/oge-vault-staging-preflight.js';
import { vaultRecoveryCenterStagingAllowed } from '../../lib/oge-vault-recovery-center.js';
import SiteNavbar from '../components/site-navbar';

export const metadata = { title: 'Oge Vault' };
export const dynamic = 'force-dynamic';

const messages = {
  connected: 'Your private GitHub repository was created and verified successfully.',
  'not-configured': 'Oge Vault has not been configured on this server yet.',
  limited: 'Too many connection attempts. Try again later.',
  'start-failed': 'Could not begin GitHub authorization. Try again.',
  'session-required': 'Your session expired. Sign in to try again.',
  'permission-denied': 'GitHub authorization was declined. No changes were made to your notes.',
  'invalid-state': 'The connection attempt expired or was already used. Please start again.',
  'unsupported-github-owner': 'A personal GitHub account is required for your private Oge Vault.',
  'github-account-mismatch': 'The authorized GitHub account does not match the GitHub identity you already linked to OgeNotes.',
  'github-permission-denied': 'GitHub did not grant the repository creation or contents permissions required.',
  'github-repository-conflict': 'A repository named ogenotes-vault already exists on this GitHub account. Oge will not overwrite it.',
  'vault-app-installation-required': 'Install the OgeNotes GitHub App on your personal account before connecting.',
  'vault-all-repositories-installation-required': 'For this first version, the GitHub App must be installed for all repositories so that the newly created private vault is accessible.',
  'vault-privacy-verification-failed': 'GitHub did not confirm a private repository owned by your account.',
  'vault-setup-failed': 'GitHub vault setup could not be completed. Your existing notes are still in MongoDB.',
};

export default async function VaultPage({ searchParams }) {
  const session = await auth();
  if (!session?.user?.id) redirect('/register');
  const db = await getDatabase();
  const user = await db.collection('users').findOne(
    ownerMutationFilter(session.user.id, { sessionVersion: session.user.sessionVersion }),
    { projection: { vault: 1, notesStorage: 1 } },
  );
  if (!user) redirect('/register');
  const result = (await searchParams)?.result;
  const vault = user.vault?.status === 'connected' ? user.vault : null;
  const configured = vaultConfigured();
  const recoveryCenterVisible = vaultRecoveryCenterStagingAllowed(process.env);
  const previewEnabled = process.env.OGE_VAULT_NOTE_API_PREVIEW === 'true';
  const mainPreviewEnabled = vaultNotesAvailable(user);
  const standaloneEditorVisible =
    process.env.OGE_VAULT_STANDALONE_EDITOR_PREVIEW === 'true' &&
    process.env.OGE_VAULT_STANDALONE_PREVIEW === 'true' &&
    process.env.OGE_VAULT_STANDALONE_DRAFT_PREVIEW === 'true' &&
    mainPreviewEnabled &&
    process.env.OGE_VAULT_NOTE_API_PREVIEW === 'true' &&
    process.env.OGE_VAULT_HYBRID_DRAFT_PREVIEW === 'true' &&
    process.env.AUTH_URL === process.env.OGE_STAGING_URL &&
    /^oge_vault_restore_staging_[a-zA-Z0-9_]{1,36}$/.test(process.env.MONGODB_DB || '') &&
    checkVaultStagingReadiness(process.env).ok;
  const currentResourceBackupVisible =
    process.env.OGE_VAULT_CURRENT_RESOURCE_BACKUP_PREVIEW === 'true' &&
    process.env.OGE_VAULT_BACKUP_EXPORT_PREVIEW === 'true' &&
    process.env.OGE_VAULT_STANDALONE_PREVIEW === 'true' &&
    mainPreviewEnabled &&
    process.env.OGE_VAULT_NOTE_API_PREVIEW === 'true' &&
    process.env.OGE_VAULT_HYBRID_DRAFT_PREVIEW === 'true' &&
    process.env.OGE_VAULT_CUTOVER_GUARD_PREVIEW !== 'true' &&
    process.env.OGE_ACCOUNT_DELETION_ENABLED !== 'true' &&
    process.env.OGE_VAULT_DESTRUCTIVE_DELETE_INTERNAL !== 'true' &&
    process.env.OGE_VAULT_SUBJECT_RETIRE_INTERNAL !== 'true' &&
    process.env.AUTH_URL === process.env.OGE_STAGING_URL &&
    /^oge_vault_restore_staging_[a-zA-Z0-9_]{1,36}$/.test(process.env.MONGODB_DB || '') &&
    checkVaultStagingReadiness(process.env).ok;
  const capturePreviewEnabled = vaultCaptureAvailable(user);
  // M62 staging-only owner workflow; never link from production.
  const restoreStagingVisible =
    process.env.OGE_VAULT_CHUNK_RESTORE_APPROVAL_PREVIEW === 'true' &&
    process.env.OGE_VAULT_NOTE_API_PREVIEW === 'true' &&
    process.env.OGE_VAULT_BACKUP_IMPORT_PLAN_PREVIEW === 'true' &&
    process.env.OGE_VAULT_BACKUP_IMPORT_COMMIT_PREVIEW === 'true' &&
    /^oge_vault_restore_staging_[a-zA-Z0-9_]{1,36}$/.test(
      process.env.MONGODB_DB || '') &&
    checkVaultStagingReadiness(process.env).ok;
  const installUrl = typeof process.env.OGE_VAULT_GITHUB_APP_SLUG === 'string' &&
    /^[a-zA-Z0-9-]{1,80}$/.test(process.env.OGE_VAULT_GITHUB_APP_SLUG)
    ? 'https://github.com/apps/' + process.env.OGE_VAULT_GITHUB_APP_SLUG + '/installations/new'
    : null;

  return (
    <main className="shell oge-shell oge-retro-workspace oge-vault-page">
      <SiteNavbar actions={<Link className="oge-signin" href="/profile">Back to Profile →</Link>} />
      <div className="oge-retro-workspace-ribbon" aria-hidden="true"><span>✳ OGE / YOUR PRIVATE ARCHIVE</span><span>GITHUB-BACKED STORAGE</span></div>
      <section className="oge-settings-hero">
        <p className="oge-eyebrow"><span className="oge-status-dot" /> PRIVATE STORAGE · PHASE A</p>
        <h1>Oge Vault<span>.</span></h1>
        <span className="oge-retro-workspace-stamp" aria-hidden="true">✳<small>YOUR NOTES</small></span>
        <p>Keep your notes in your own private GitHub repository. Write, save, and find them from one workspace.</p>
      </section>
      {user.notesStorage === 'github' && !vault && (
        <p className="oge-settings-note" role="status">You chose GitHub Vault during onboarding. Complete the connection below before writing Notes; Oge will not silently save them to MongoDB instead.</p>
      )}
      <div className="oge-settings-card oge-vault-card">
        <div className="oge-settings-card-heading">
          <div><span className="oge-section-kicker">01 · CONNECT</span><h2>Private GitHub vault</h2></div>
          <span className="oge-settings-pill">{vault ? 'Repository connected' : configured ? 'Not connected' : 'Setup pending'}</span>
        </div>
        {typeof result === 'string' && messages[result] && (
          <p role={result === 'connected' ? 'status' : 'alert'}
            className={result === 'connected' ? 'oge-profile-success' : 'oge-password-error'}>{messages[result]}</p>
        )}
        {vault ? (
          <>
            <p className="oge-settings-description">Connected to a private GitHub repository owned by <strong>{vault.githubLogin}</strong>.</p>
            <p className="oge-vault-repository"><span aria-hidden="true">▣</span> {vault.githubLogin}/{vault.repoName} <span>PRIVATE</span></p>
            <p className="oge-settings-note">{user.notesStorage === 'mongodb'
              ? 'You selected MongoDB for your everyday Notes. This GitHub repository remains connected, but your Notes still use the MongoDB workspace until you explicitly change storage and review any migration.'
              : 'Your Notes workspace saves committed Notes in your private GitHub repository. Quick Capture uses the same subjects and saves there when you press Save. Other legacy note features remain separate until migrated.'}</p>
            {/* The familiar Notes UI is the only everyday editing entrypoint.
                Keep the older B3 preview out of the connected-user navigation. */}
            {previewEnabled && !mainPreviewEnabled &&
              <Link className="oge-primary-link" href="/vault/preview">Open legacy Notes preview →</Link>}
            {mainPreviewEnabled && <Link className="oge-primary-link" href="/vault/notes">Open My Notes →</Link>}
            {githubVaultFilesEnabled(user) &&
              <Link className="oge-primary-link" href="/files">Open My Files →</Link>}
            {capturePreviewEnabled && <Link className="oge-primary-link" href="/vault/capture">Write a Quick Note →</Link>}
            {standaloneEditorVisible && <Link className="oge-primary-link" href="/vault/standalone-editor">GitHub-backed Quick Notes &amp; AirNotes (staging preview) →</Link>}
            {recoveryCenterVisible && <Link className="oge-primary-link" href="/vault/recovery">Recovery Center — coverage and safety status →</Link>}
            {user.notesStorage !== 'mongodb' && <>
              <p className="oge-settings-note">Need a copy of everything currently committed in your Vault, including Saved Links and My Files? Open your private repository on GitHub, select <strong>Code → Download ZIP</strong>. This downloads a repository snapshot, not an Oge one-click restore. Keep it private; unsaved drafts are not included.</p>
              <a className="oge-primary-link" href={'https://github.com/' + encodeURIComponent(vault.githubLogin) + '/' + encodeURIComponent(vault.repoName)} target="_blank" rel="noopener noreferrer">Open GitHub Vault for complete ZIP backup ↗</a>
            </>}
            {currentResourceBackupVisible && <>
              <p className="oge-settings-note">Staging three-resource current snapshot backup includes private plaintext committed Notes, Quick Notes and AirNotes. Secure the downloaded JSON. Historical revisions, drafts and other account data are NOT included, and this file cannot be imported yet.</p>
              <a className="oge-primary-link" href="/api/vault/backup-current-resources" download="oge-vault-current-resources.json">Download current committed Vault resources (staging only) ↓</a>
            </>}
            {restoreStagingVisible && <Link className="oge-primary-link" href="/vault/restore-staging">Review staging-only backup restore →</Link>}
          </>
        ) : (
          <>
            <p className="oge-settings-description">Connect your personal GitHub account to create a private <code>ogenotes-vault</code> repository. No Git commands or manual repository creation are needed.</p>
            <ol className="oge-vault-connect-list" aria-label="GitHub Vault connection steps">
              <li className="oge-vault-connect-step">
                <h3>1. Install the OgeNotes GitHub App</h3>
                <p>GitHub will ask you to choose your personal account and approve the App installation. For the current version, choose <strong>All repositories</strong> if GitHub asks for repository access.</p>
                {installUrl ? (
                  <a className="oge-primary-link" href={installUrl} target="_blank" rel="noopener noreferrer">Install the GitHub App ↗</a>
                ) : (
                  <p className="oge-settings-note" role="status">The installation link is unavailable because the server has not set the GitHub App slug. If you already installed the App, you may continue below; otherwise the site owner must finish its GitHub App setup.</p>
                )}
              </li>
              <li className="oge-vault-connect-step">
                <h3>2. Connect and authorize GitHub</h3>
                <p>After installation, return here and select this button. You will be sent to GitHub to approve access, then back to OgeNotes automatically.</p>
                {configured ? (
                  <form action="/api/vault/start" method="POST">
                    <button className="oge-google-button" type="submit">Connect GitHub &amp; create my Vault →</button>
                  </form>
                ) : (
                  <>
                    <button className="oge-google-button" type="button" disabled aria-disabled="true">Connect GitHub — server setup required</button>
                    <p className="oge-password-error" role="alert">Connection cannot begin on this OgeNotes server yet: its GitHub App credentials or callback URL have not been configured. The site owner must configure the Vault integration; signing in with GitHub alone does not connect your Notes storage.</p>
                    <a className="oge-primary-link" href="https://github.com/nikhil-dex/oge/blob/feature/oge-vault-foundation/docs/OGE_VAULT_PHASE_A.md" target="_blank" rel="noopener noreferrer">Developer: GitHub App configuration guide ↗</a>
                  </>
                )}
              </li>
              <li className="oge-vault-connect-step">
                <h3>3. Your private Vault is created automatically</h3>
                <p>Once GitHub authorization succeeds, OgeNotes creates and verifies the private repository. A confirmation and an <strong>Open My Notes</strong> link will appear on this page.</p>
              </li>
            </ol>
            {configured && !installUrl && <p className="oge-settings-note">Already installed the GitHub App? You can still select <strong>Connect GitHub</strong> above. If GitHub reports that installation is required, the site owner needs to publish the App installation link.</p>}
            <p className="oge-settings-note">The current App installation may request access to all repositories, although Oge&apos;s Notes-writing token is limited to the private Vault repository. Review GitHub&apos;s permission screen before approving.</p>
          </>
        )}
      </div>
      <p className="oge-vault-footnote">Connecting your GitHub Vault never moves, deletes or copies existing MongoDB Notes automatically. If you selected GitHub during onboarding, your Notes workspace becomes available after a successful connection and the GitHub Notes service is enabled.</p>
    </main>
  );
}
