import { auth } from '../../auth.js';
import { getDatabase } from '../../lib/mongodb.js';
import { redirect } from 'next/navigation';
import { saveNewsInterests } from '../onboarding/actions.js';
import { NEWS_TOPICS } from '../../lib/news-topics.js';
import { signOutOfOgeNotes } from './actions.js';
import SettingsClient from './settings-client.js';
import SiteNavbar from '../components/site-navbar';

export const metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const session = await auth();
  const ownerId = session?.user?.id;
  if (!ownerId) redirect('/register');

  const db = await getDatabase();
  const user = await db.collection('users').findOne(
    { googleSub: ownerId },
    { projection: { name: 1, email: 1, image: 1, newsInterests: 1, createdAt: 1, lastLoginAt: 1 } },
  );
  const displayName = user?.name || session.user.name || 'OgeNotes user';
  const email = user?.email || session.user.email || 'Google account';

  return (
    <main className="shell oge-shell oge-settings-page">
      <SiteNavbar actions={<a className="oge-signin" href="/">Back to dashboard <span aria-hidden="true">↗</span></a>} />
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
          <a href="#pixel-strip">Pixel Strip</a>
          <a href="#news-preferences">News preferences</a>
          <a href="#data">Your data</a>
        </aside>

        <div className="oge-settings-content">
          <section className="oge-settings-card" id="account" aria-labelledby="account-heading">
            <div className="oge-settings-card-heading"><div><span className="oge-section-kicker">01 · ACCOUNT</span><h2 id="account-heading">Your account</h2></div><span className="oge-settings-pill"><span className="oge-status-dot" /> Connected</span></div>
            <div className="oge-account-row">
              {user?.image || session.user.image ? <img className="oge-account-avatar" src={user?.image || session.user.image} alt="" referrerPolicy="no-referrer" /> : <span className="oge-account-avatar oge-account-avatar-fallback" aria-hidden="true">{displayName.slice(0,1).toUpperCase()}</span>}
              <div className="oge-account-details"><strong>{displayName}</strong><span>{email}</span><small>Signed in securely with Google</small></div>
            </div>
            <p className="oge-settings-note">Your account is used to keep your notes, quick notes, saved links, and preferences private to you.</p>
            <form action={signOutOfOgeNotes} className="oge-settings-signout"><button className="oge-settings-danger-button" type="submit">Sign out <span aria-hidden="true">↗</span></button></form>
          </section>

          <SettingsClient />

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

          <footer className="oge-settings-footer"><a className="oge-brand" href="/"><span className="oge-brand-mark">O</span><span>OgeNotes</span></a><span>YOUR WORKSPACE · YOUR WAY</span></footer>
        </div>
      </div>
    </main>
  );
}
