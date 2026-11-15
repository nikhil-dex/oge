import Link from 'next/link';
import Image from 'next/image';
import { auth } from '../../auth.js';
import { getDatabase } from '../../lib/mongodb.js';
import { redirect } from 'next/navigation';
import { saveNewsInterests } from '../onboarding/actions.js';
import { NEWS_TOPICS } from '../../lib/news-topics.js';
import { signOutOfOgeNotes } from './actions.js';
import { reauthenticateWithGoogle, setLinkedPassword } from './password-actions.js';
import { isRecentGoogleAuthentication } from '../../lib/password-auth.js';
import SettingsClient from './settings-client.js';
import { ownerMutationFilter } from '../../lib/active-owner-mutation.js';
import SiteNavbar from '../components/site-navbar';

export const metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

export default async function SettingsPage({ searchParams }) {
  const session = await auth();
  const query = await searchParams;
  const ownerId = session?.user?.id;
  if (!ownerId) redirect('/register');

  const db = await getDatabase();
  const accountFilter = ownerMutationFilter(ownerId, { sessionVersion: session.user.sessionVersion });
  const user = await db.collection('users').findOne(
    accountFilter,
    { projection: { name: 1, email: 1, image: 1, newsInterests: 1, createdAt: 1, lastLoginAt: 1, passwordHash: 1 } },
  );
  if (!user) redirect('/register');
  const displayName = user.name || session.user.name || 'OgeNotes user';
  const email = user?.email || session.user.email || 'Google account';

  return (
    <main className="shell oge-shell oge-settings-page">
      <SiteNavbar actions={<Link className="oge-signin" href="/">Back to dashboard <span aria-hidden="true">↗</span></Link>} />
      <section className="oge-settings-hero">
        <p className="oge-eyebrow"><span className="oge-status-dot" /> YOUR WORKSPACE</p>
        <h1>Settings<span>.</span></h1>
        <p>Make OgeNotes work the way you do. Manage your subjects, personalize the interface, and keep your data safe.</p>
      </section>

      <div className="oge-settings-layout">
        <aside className="oge-settings-sidebar" aria-label="Settings sections">
          <a href="#account">Account</a>
          <a href="#organization">Subjects</a>
          <a href="#appearance">Appearance</a>
          <a href="#gemini-ai">Gemini AI</a>
          <a href="#pixel-strip">Pixel Strip</a>
          <a href="#news-preferences">News preferences</a>
          <a href="#data">Your data</a>
        </aside>

        <div className="oge-settings-content">
          <section className="oge-settings-card" id="account" aria-labelledby="account-heading">
            <div className="oge-settings-card-heading"><div><span className="oge-section-kicker">01 · ACCOUNT</span><h2 id="account-heading">Your account</h2></div><span className="oge-settings-pill"><span className="oge-status-dot" /> Connected</span></div>
            <div className="oge-account-row">
              {user?.image || session.user.image ? <Image className="oge-account-avatar" src={user?.image || session.user.image} alt="" width={48} height={48} unoptimized referrerPolicy="no-referrer" /> : <span className="oge-account-avatar oge-account-avatar-fallback" aria-hidden="true">{displayName.slice(0,1).toUpperCase()}</span>}
              <div className="oge-account-details"><strong>{displayName}</strong><span>{email}</span><small>Google verified account</small></div>
            </div>
            <p className="oge-settings-note">Your account is used to keep your notes, quick notes, saved links, and preferences private to you.</p>
            <div className="oge-password-settings">
              <h3>Sign in without Google</h3>
              <p>Use your Gmail address and a separate OgeNotes password on college or library computers.</p>
              <p>{user.passwordHash ? 'Password sign-in is enabled. Reauthenticate with Google to replace your password.' : 'Password sign-in is optional. Set it up after a recent Google sign-in.'}</p>
              {['invalid', 'reauth', 'limited', 'failed'].includes(query?.password) &&
                <p role="alert" className="oge-password-error">{query.password === 'invalid' ? 'Use a matching password of 12–128 characters.' : query.password === 'reauth' ? 'Reauthenticate with Google to set your password.' : query.password === 'limited' ? 'Too many attempts. Try again later.' : 'Password setup could not be completed.'}</p>}
              {isRecentGoogleAuthentication(session) ? (
                <form action={setLinkedPassword} className="oge-password-login-form">
                  <label htmlFor="new-oge-password">New OgeNotes password</label>
                  <input id="new-oge-password" name="password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required />
                  <label htmlFor="confirm-oge-password">Confirm password</label>
                  <input id="confirm-oge-password" name="confirmPassword" type="password" autoComplete="new-password" minLength={12} maxLength={128} required />
                  <button type="submit" className="oge-google-button">{user.passwordHash ? 'Replace password' : 'Set OgeNotes password'} →</button>
                  <small>All existing sessions will be signed out when this password is saved.</small>
                </form>
              ) : (
                <form action={reauthenticateWithGoogle}>
                  <button className="oge-google-button" type="submit">Verify with Google to manage password →</button>
                </form>
              )}
            </div>
            <form action={signOutOfOgeNotes} className="oge-settings-signout"><button className="oge-settings-danger-button" type="submit">Sign out <span aria-hidden="true">↗</span></button></form>
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

          <footer className="oge-settings-footer"><Link className="oge-brand" href="/"><span className="oge-brand-mark">O</span><span>OgeNotes</span></Link><span>YOUR WORKSPACE · YOUR WAY</span></footer>
        </div>
      </div>
    </main>
  );
}
