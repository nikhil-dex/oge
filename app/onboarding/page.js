import { auth } from '../../auth.js';
import { getDatabase } from '../../lib/mongodb.js';
import { redirect } from 'next/navigation';
import { NEWS_TOPICS, saveNewsInterests } from './actions.js';

export const metadata = { title: 'Personalize your news' };
export const dynamic = 'force-dynamic';

export default async function OnboardingPage() {
  const session = await auth();
  const ownerId = session?.user?.id;
  if (!ownerId) redirect('/register');
  const db = await getDatabase();
  const user = await db.collection('users').findOne({ googleSub: ownerId }, { projection: { onboardingComplete: 1, newsInterests: 1 } });
  if (user?.onboardingComplete) redirect('/');
  return (
    <main className="shell oge-placeholder oge-onboarding-page">
      <a className="oge-brand" href="/"><span className="oge-brand-mark">O</span><span>OgeNotes</span></a>
      <div className="oge-eyebrow"><span className="oge-status-dot" /> ONE LAST THING</div>
      <h1>Make news<br /><span>yours.</span></h1>
      <p className="oge-placeholder-copy">Pick the topics you care about. We'll use these preferences to personalize your news feed. You can change them any time in Settings.</p>
      <form action={saveNewsInterests} className="oge-interest-form">
        <div className="oge-interest-grid">
          {NEWS_TOPICS.map((topic) => (
            <label key={topic} className="oge-interest-option">
              <input type="checkbox" name="interest" value={topic} defaultChecked={user?.newsInterests?.includes(topic) || ['Technology', 'Artificial Intelligence', 'Science'].includes(topic)} />
              <span>{topic}</span>
            </label>
          ))}
        </div>
        <div className="oge-onboarding-actions"><button className="oge-google-button" name="action" value="save" type="submit">Save interests <span aria-hidden="true">→</span></button><button className="oge-skip-button" name="action" value="skip" type="submit" formNoValidate>Skip for now</button></div>
        <p className="oge-register-footnote">Choose up to 10 topics. Skipping gives you a general news feed.</p>
      </form>
    </main>
  );
}
