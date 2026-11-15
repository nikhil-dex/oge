import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '../../auth.js';
import { getDatabase } from '../../lib/mongodb.js';
import { ownerMutationFilter } from '../../lib/active-owner-mutation.js';
import { vaultConfigured } from '../../lib/oge-vault-github.js';
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
    { projection: { vault: 1 } },
  );
  if (!user) redirect('/register');
  const result = (await searchParams)?.result;
  const vault = user.vault?.status === 'connected' ? user.vault : null;
  const configured = vaultConfigured();
  const previewEnabled = process.env.OGE_VAULT_NOTE_API_PREVIEW === 'true';
  const mainPreviewEnabled = process.env.OGE_VAULT_MAIN_PREVIEW === 'true';
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
        <p>Your own private repository on GitHub. Oge is building a safer, student-owned home for your notes.</p>
      </section>
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
            <p className="oge-settings-note">The GitHub Notes preview is separate from the main Notes workspace. The current Notes, Quick Notes and AirNotes still use legacy MongoDB endpoints until cutover. Existing records have been identified as disposable test data, pending inventory and cleanup.</p>
            {previewEnabled && <Link className="oge-primary-link" href="/vault/preview">Open GitHub-only Notes preview →</Link>}
            {mainPreviewEnabled && <Link className="oge-primary-link" href="/vault/notes">Open familiar Notes interface (GitHub-only) →</Link>
          </>
        ) : (
          <>
            <p className="oge-settings-description">Authorize the OgeNotes GitHub App once. Oge will create a fresh private repository named <code>ogenotes-vault</code> under your own personal GitHub account. No Git knowledge required.</p>
            <div className="oge-vault-steps">
              <span><strong>01</strong> Install the GitHub App</span>
              <span><strong>02</strong> Authorize your GitHub identity</span>
              <span><strong>03</strong> Create and verify your private vault</span>
            </div>
            {installUrl && <a className="oge-primary-link" href={installUrl} target="_blank" rel="noopener noreferrer">Install OgeNotes GitHub App ↗</a>}
            {configured ? <form action="/api/vault/start" method="POST">
              <button className="oge-google-button" type="submit">Connect GitHub &amp; create private vault →</button>
            </form> : <p className="oge-settings-note">The OgeNotes GitHub App configuration must be completed before vault setup becomes available.</p>}
            <p className="oge-settings-note">For now, the GitHub App requires an all-repositories installation to allow creation of a new repository. Oge uses a token restricted to your vault repository for writing notes. Do not proceed unless you are comfortable with that installation scope.</p>
          </>
        )}
      </div>
      <p className="oge-vault-footnote">Your current notes are not moved, deleted, or copied by connecting your vault. Mandatory GitHub-backed Notes access will be enabled only after full cutover tests and reviewed cleanup of disposable MongoDB test records.</p>
    </main>
  );
}
