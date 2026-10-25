import { auth } from '../../auth.js';
import { getDatabase } from '../../lib/mongodb.js';
import { redirect } from 'next/navigation';
import { saveNewsInterests } from '../onboarding/actions.js';
import { NEWS_TOPICS } from '../../lib/news-topics.js';
import { signOutOfOgeNotes } from './actions.js';

export const metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const session = await auth();
  const ownerId = session?.user?.id;
  if (!ownerId) redirect('/register');
  const db = await getDatabase();
  const user = await db.collection('users').findOne({ googleSub: ownerId }, { projection: { name: 1, email: 1, newsInterests: 1 } });
  return (
    <main className="shell oge-placeholder oge-onboarding-page">
      <a className="oge-back-link" href="/">← Back to dashboard</a>
      <div className="oge-eyebrow"><span className="oge-status-dot" /> YOUR ACCOUNT</div>
      <h1>Settings<span>.</span></h1>
      <p className="oge-placeholder-copy">Signed in as {user?.email || session.user.email || 'Google account'}. Your notes and preferences are stored in your OgeNotes account.</p>
      <section className="oge-settings-section"><span className="oge-section-kicker">NEWS PERSONALIZATION</span><h2>What are you interested in?</h2><p className="oge-placeholder-copy">Select up to 10 topics. Leave all unchecked for a general feed.</p>
        <form action={saveNewsInterests} className="oge-interest-form">
          <input type="hidden" name="returnTo" value="/settings" />
          <div className="oge-interest-grid">
            {NEWS_TOPICS.map((topic) => (
              <label key={topic} className="oge-interest-option"><input type="checkbox" name="interest" value={topic} defaultChecked={user?.newsInterests?.includes(topic) || false} /><span>{topic}</span></label>
            ))}
          </div>
          <div className="oge-onboarding-actions"><button className="oge-google-button" name="action" value="save" type="submit">Save preferences <span aria-hidden="true">→</span></button></div>
        </form>
      </section>
      <form action={signOutOfOgeNotes} className="oge-signout-form"><button className="oge-skip-button" type="submit">Sign out</button></form>
    </main>
  );
}
