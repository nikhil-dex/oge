import { auth } from '../auth.js';
import { getDatabase } from '../lib/mongodb.js';
import { redirect } from 'next/navigation';
import ThemeToggle from './components/theme-toggle';
import HomeNewsFeed from './components/home-news-feed';

const modules = [
  { number: '01', group: 'LEARN', title: 'Notes', description: 'Organize ideas, study material, and everything worth keeping.', href: '/notes', icon: '▤', featured: true },
  { number: '03', group: 'COLLECT', title: 'Saved Links', description: 'Keep useful websites, tools, and references close.', href: '/saved-links', icon: '↗' },
  { number: '04', group: 'CAPTURE', title: 'Browser Extension', description: 'Bring useful links into your knowledge space.', href: '/extension', icon: '⬡' },
  { number: '05', group: 'HISTORY', title: 'Revision History', description: 'Return to recent study activity and previous revisions.', href: '/revision-history', icon: '◷' },
  { number: '06', group: 'DISCOVER', title: 'Dictionary', description: 'Look up words and build your vocabulary.', href: '/dictionary', icon: 'Aa' },
  { number: '08', group: 'REVIEW', title: 'Revision', description: 'Focus on recall and revisit what you have learned.', href: '/revision', icon: '↻' },
];

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/register');
  const db = await getDatabase();
  const account = await db.collection('users').findOne({ googleSub: session.user.id }, { projection: { onboardingComplete: 1 } });
  if (!account?.onboardingComplete) redirect('/onboarding');

  return (
    <main className="shell hub-shell oge-shell">
      <header className="oge-topbar">
        <a className="oge-brand" href="/" aria-label="OgeNotes home"><span className="oge-brand-mark">O</span><span>OgeNotes</span></a>
        <nav className="oge-nav" aria-label="Main navigation"><a className="is-active" href="/">Home</a><a href="/notes">Notes</a><a href="/news">News</a></nav>
        <div className="oge-top-actions"><a className="oge-signin" href="/settings">Settings <span aria-hidden="true">↗</span></a><ThemeToggle /></div>
      </header>

      <HomeNewsFeed />

      <section className="quick-notes-section oge-airnotes-preview" aria-labelledby="airnotes-heading">
        <div className="quick-notes-heading-row">
          <div>
            <p className="eyebrow">PERSONAL KNOWLEDGE SPACE</p>
            <h2 id="airnotes-heading">Air<span>Notes.</span></h2>
            <p className="quick-notes-lead">A focused space for capturing ideas, keeping references, and developing thoughts.</p>
          </div>
          <a className="quick-note-add-button" href="/airnotes">Open AirNotes <span aria-hidden="true">→</span></a>
        </div>
        <a className="hub-card oge-airnotes-card" href="/airnotes">
          <span className="hub-card-icon" aria-hidden="true">⌁</span>
          <span className="hub-card-kicker">02 · CAPTURE</span>
          <h2>Your ideas, in one place <span aria-hidden="true">↗</span></h2>
          <p>Keep longer thoughts and working drafts separate from quick, temporary notes.</p>
          <span className="hub-card-link">Go to AirNotes <span aria-hidden="true">→</span></span>
        </a>
      </section>

      <section className="oge-module-section" aria-labelledby="modules-title">
        <div className="oge-section-heading">
          <div><span className="oge-section-kicker">YOUR TOOLKIT</span><h2 id="modules-title">Everything in its place.</h2></div>
          <span className="oge-count">06 MODULES</span>
        </div>
        <div className="hub-grid oge-module-grid">
          {modules.map((item) => (
            <a key={item.href} className={item.featured ? 'hub-card oge-module-card hub-card-featured' : 'hub-card oge-module-card'} href={item.href}>
              <div className="oge-module-card-top"><span className="oge-module-icon" aria-hidden="true">{item.icon}</span><span className="hub-card-kicker">{item.number} · {item.group}</span></div>
              <h3>{item.title} <span aria-hidden="true">↗</span></h3>
              <p>{item.description}</p>
              <span className="hub-card-link">Open {item.title} <span aria-hidden="true">→</span></span>
            </a>
          ))}
        </div>
      </section>

      <section className="quick-notes-section oge-quick-notes-bottom" aria-labelledby="quick-notes-heading">
        <div className="quick-notes-heading-row">
          <div>
            <p className="eyebrow">LIGHTWEIGHT CAPTURE</p>
            <h2 id="quick-notes-heading">Quick <span>Notes.</span></h2>
            <p className="quick-notes-lead">Catch a thought before it disappears. Keep short reminders easy to reach.</p>
          </div>
          <a className="quick-note-add-button" href="/quick-notes"><span aria-hidden="true">＋</span> Open Quick Notes</a>
        </div>
        <a className="hub-card oge-quick-notes-card" href="/quick-notes">
          <span className="hub-card-icon" aria-hidden="true">✳</span>
          <span className="hub-card-kicker">09 · CAPTURE</span>
          <h2>A place for passing thoughts <span aria-hidden="true">↗</span></h2>
          <p>Open your Quick Notes workspace for short ideas, reminders, and things to sort out later.</p>
          <span className="hub-card-link">Go to Quick Notes <span aria-hidden="true">→</span></span>
        </a>
      </section>

      <footer className="oge-footer"><a className="oge-brand oge-footer-brand" href="/"><span className="oge-brand-mark">O</span><span>OgeNotes</span></a><span>A little more organized, every day.</span><a href="/settings">Settings <span aria-hidden="true">↗</span></a></footer>
    </main>
  );
}
