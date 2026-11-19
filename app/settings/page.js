import Link from 'next/link';
import { auth } from '../../auth.js';
import { getDatabase } from '../../lib/mongodb.js';
import { redirect } from 'next/navigation';
import { saveNewsInterests } from '../onboarding/actions.js';
import { NEWS_TOPICS } from '../../lib/news-topics.js';
import { vaultConfigured } from '../../lib/oge-vault-github.js';
import SettingsClient from './settings-client.js';
import { ownerMutationFilter } from '../../lib/active-owner-mutation.js';
import SiteNavbar from '../components/site-navbar';

export const metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const session = await auth();
  const ownerId = session?.user?.id;
  if (!ownerId) redirect('/register');

  const db = await getDatabase();
  const accountFilter = ownerMutationFilter(ownerId, { sessionVersion: session.user.sessionVersion });
  const user = await db.collection('users').findOne(
    accountFilter,
    { projection: { newsInterests: 1, notesStorage: 1, vault: 1 } },
  );
  if (!user) redirect('/register');
  const vaultConnected = user.vault?.status === 'connected';
  const vaultEnabled = vaultConfigured();

  return (
    <main className="shell oge-shell oge-settings-page oge-retro-workspace">
      <SiteNavbar actions={<Link className="oge-signin" href="/">Back to dashboard <span aria-hidden="true">↗</span></Link>} />
      <div className="oge-retro-workspace-ribbon" aria-hidden="true"><span>✳ OGE / PERSONAL ARCHIVE</span><span>FIELD NOTES · VOL. 01</span><span>✦ MADE FOR CURIOUS MINDS</span></div>
      <section className="oge-settings-hero">
        <p className="oge-eyebrow"><span className="oge-status-dot" /> YOUR WORKSPACE</p>
        <h1>Settings<span>.</span></h1>
        <span className="oge-retro-workspace-stamp" aria-hidden="true">✳<small>YOUR SPACE</small></span>
        <p>Make OgeNotes work the way you do. Manage your subjects, personalize the interface, and keep your data safe.</p>
      </section>

      <div className="oge-settings-layout">
        <aside className="oge-settings-sidebar" aria-label="Settings sections">
          <Link href="/profile">Profile &amp; security</Link>
          <a href="#organization">Subjects</a>
          <a href="#appearance">Appearance</a>
          <a href="#gemini-ai">Gemini AI</a>
          <a href="#pixel-strip">Pixel Strip</a>
          <a href="#news-preferences">News preferences</a>
          <a href="#vault-connection">GitHub Vault</a>
          <a href="#data">Your data</a>
        </aside>

        <div className="oge-settings-content">
          <section className="oge-settings-card" aria-labelledby="account-shortcut-heading">
            <div className="oge-settings-card-heading">
              <div><span className="oge-section-kicker">01 · ACCOUNT</span><h2 id="account-shortcut-heading">Profile &amp; security</h2></div>
            </div>
            <p className="oge-settings-description">Manage your display name, unique username, profile avatar, login password and sign-out controls in one place.</p>
            <Link className="oge-primary-link" href="/profile">Open your profile →</Link>
          </section>

          <SettingsClient accountDeletionEnabled={process.env.OGE_ACCOUNT_DELETION_ENABLED === 'true'} />

          <section className="oge-settings-card" id="news-preferences" aria-labelledby="news-preferences-heading">
            <div className="oge-settings-card-heading"><div><span className="oge-section-kicker">05 · PERSONALIZATION</span><h2 id="news-preferences-heading">News preferences</h2></div></div>
            <p className="oge-settings-description">Choose topics for your personalized news feed. Select up to 10, or leave everything unchecked for a general feed.</p>
            <form action={saveNewsInterests} className="oge-interest-form oge-settings-interest-form">
              <input type="hidden" name="returnTo" value="/settings" />
              <div className="oge-interest-grid">
                {NEWS_TOPICS.map((topic) => (
                  <label key={topic} className="oge-interest-option">
                    <input type="checkbox" name="interest" value={topic} defaultChecked={user?.newsInterests?.includes(topic) || false} />
                    <span>{topic}</span>
                  </label>
                ))}
              </div>
              <div className="oge-settings-form-actions"><button className="oge-google-button" name="action" value="save" type="submit">Save news preferences <span aria-hidden="true">→</span></button></div>
            </form>
          </section>

          <section className="oge-settings-card" id="vault-connection" aria-labelledby="vault-connection-heading">
            <div className="oge-settings-card-heading">
              <div><span className="oge-section-kicker">06 · NOTES STORAGE</span><h2 id="vault-connection-heading">GitHub Vault connection</h2></div>
              <span className="oge-settings-pill">{vaultConnected ? 'Connected' : vaultEnabled ? 'Ready to connect' : 'Setup required'}</span>
            </div>
            <p className="oge-settings-description">{vaultConnected
              ? 'Your private GitHub Vault is connected. Open the Vault page to see the repository and GitHub Notes workspace.'
              : 'Connect a private GitHub repository for committed Notes. The Vault setup page has an installation link, an authorization button and connection status.'}</p>
            <p className="oge-settings-note">Notes storage selected: <strong>{user.notesStorage === 'github' ? 'GitHub Vault' : user.notesStorage === 'mongodb' ? 'MongoDB' : 'Existing workspace / not yet selected'}</strong>. Connecting a GitHub repository does not automatically move previously saved MongoDB Notes or change a MongoDB storage selection.</p>
            <Link className="oge-primary-link" href="/vault">{vaultConnected ? 'Manage my connected GitHub Vault →' : 'Set up GitHub Vault →'}</Link>
            {!vaultConnected && !vaultEnabled && <p className="oge-settings-note" role="status">The GitHub connection button will be unavailable until Oge&apos;s GitHub App is configured on this server. Open the setup page for the configuration guide.</p>}
          </section>

          <footer className="oge-settings-footer"><Link className="oge-brand" href="/"><span className="oge-brand-mark">O</span><span>OgeNotes</span></Link><span>YOUR WORKSPACE · YOUR WAY</span></footer>
        </div>
      </div>
    </main>
  );
}
