import Link from 'next/link';
import { auth } from '../../auth.js';
import { getDatabase } from '../../lib/mongodb.js';
import { redirect } from 'next/navigation';
import { saveNewsInterests } from './actions.js';
import { NEWS_TOPICS } from '../../lib/news-topics.js';

export const metadata = { title: 'Personalize your OgeNotes workspace' };
export const dynamic = 'force-dynamic';

export default async function OnboardingPage() {
  const session = await auth();
  const ownerId = session?.user?.id;
  if (!ownerId) redirect('/register');
  const db = await getDatabase();
  const user = await db.collection('users').findOne({ googleSub: ownerId }, { projection: { onboardingComplete: 1, newsInterests: 1, notesStorage: 1 } });
  if (user?.onboardingComplete) redirect('/');
  return (
    <main className="shell oge-placeholder oge-onboarding-page">
      <Link className="oge-brand" href="/"><span className="oge-brand-mark">O</span><span>OgeNotes</span></Link>
      <div className="oge-eyebrow"><span className="oge-status-dot" /> SET UP YOUR WORKSPACE</div>
      <h1>Make OgeNotes<br /><span>yours.</span></h1>
      <p className="oge-placeholder-copy">Choose your news interests and where your Notes should live. News interests can be changed later in Settings.</p>
      <form action={saveNewsInterests} className="oge-interest-form">
        <h2 className="oge-onboarding-section-title">01 · News interests</h2>
        <p className="oge-onboarding-description">Choose up to 10 topics, or skip news personalization.</p>
        <div className="oge-interest-grid">
          {NEWS_TOPICS.map((topic) => (
            <label key={topic} className="oge-interest-option">
              <input type="checkbox" name="interest" value={topic} defaultChecked={user?.newsInterests?.includes(topic) || ['Technology', 'Artificial Intelligence', 'Science'].includes(topic)} />
              <span>{topic}</span>
            </label>
          ))}
        </div>
        <fieldset className="oge-storage-fieldset">
          <legend className="oge-onboarding-section-title">02 · Choose your Notes storage</legend>
          <p className="oge-onboarding-description">Both options use MongoDB for your account, subjects and preferences. The difference is where your committed Note content lives.</p>
          <div className="oge-storage-options">
            <label className="oge-storage-option">
              <input type="radio" name="notesStorage" value="mongodb" required defaultChecked={user?.notesStorage === 'mongodb'} />
              <span className="oge-storage-option-body">
                <span className="oge-storage-option-heading"><strong>Oge Cloud · MongoDB</strong><small>Simple and ready to use</small></span>
                <span>Write immediately without linking a GitHub account. Notes are saved in Oge&apos;s managed database.</span>
                <span className="oge-storage-feature">Save your Notes to Oge Cloud · familiar Notes and Quick Notes · managed by Oge</span>
                <span className="oge-storage-tradeoff">No personal Git repository or Git commit history. Your Notes rely on Oge&apos;s service.</span>
              </span>
            </label>
            <label className="oge-storage-option">
              <input type="radio" name="notesStorage" value="github" required defaultChecked={user?.notesStorage === 'github'} />
              <span className="oge-storage-option-body">
                <span className="oge-storage-option-heading"><strong>Oge Vault · GitHub</strong><small>Own your private repository</small></span>
                <span>Commit Notes into a private GitHub repository under your account, with Git history and portable files.</span>
                <span className="oge-storage-feature">Explicit GitHub Save · temporary draft autosave in MongoDB and this browser · Git version history</span>
                <span className="oge-storage-tradeoff">Requires a GitHub account, GitHub App authorization and connectivity. Connection setup is the next step.</span>
              </span>
            </label>
          </div>
        </fieldset>
        <div className="oge-onboarding-actions">
          <button className="oge-google-button" name="action" value="save" type="submit">Continue with my choices <span aria-hidden="true">→</span></button>
          <button className="oge-skip-button" name="action" value="skip" type="submit">Skip news topics</button>
        </div>
        <p className="oge-register-footnote">Select one Notes storage option to continue. Skipping news gives you a general feed; it never overrides your storage choice.</p>
      </form>
    </main>
  );
}
