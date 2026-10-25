import { auth } from '../auth.js';
import { getDatabase } from '../lib/mongodb.js';
import { redirect } from 'next/navigation';
import ThemeToggle from './components/theme-toggle';

const modules = [
  { number: '01', group: 'CAPTURE', title: 'Notes', description: 'Organize ideas, study material, and everything worth keeping.', href: '/notes', icon: '▤', featured: true },
  { number: '02', group: 'CAPTURE', title: 'AirNotes', description: 'A dedicated space for your AirNotes workflow.', href: '/airnotes', icon: '⌁' },
  { number: '03', group: 'CAPTURE', title: 'Quick Notes', description: 'Catch a thought before it disappears.', href: '/quick-notes', icon: '✳' },
  { number: '04', group: 'COLLECT', title: 'Saved Links', description: 'Keep useful websites, tools, and references close.', href: '/saved-links', icon: '↗' },
  { number: '05', group: 'COLLECT', title: 'Browser Extension', description: 'Bring useful links into your knowledge space.', href: '/extension', icon: '⬡' },
  { number: '06', group: 'REVIEW', title: 'Revision History', description: 'Return to recent study activity and previous revisions.', href: '/revision-history', icon: '◷' },
  { number: '07', group: 'DISCOVER', title: 'Dictionary', description: 'Look up words and build your vocabulary.', href: '/dictionary', icon: 'Aa' },
  { number: '08', group: 'DISCOVER', title: 'News', description: 'A feed tailored to topics you care about.', href: '/news', icon: '▥' },
  { number: '09', group: 'REVIEW', title: 'Revision', description: 'Focus on recall and revisit what you have learned.', href: '/revision', icon: '↻' },
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
        <div className="oge-top-actions"><a className="oge-signin" href="/register">Get started <span aria-hidden="true">↗</span></a><ThemeToggle /></div>
      </header>

      <section className="oge-hero">
        <div className="oge-eyebrow"><span className="oge-status-dot" /> YOUR PERSONAL KNOWLEDGE SPACE</div>
        <h1>Make room for<br /><span>what matters.</span></h1>
        <p className="oge-hero-copy">One calm space for the things you learn, the ideas you collect, and the things you want to remember.</p>
        <div className="oge-hero-meta"><span>CAPTURE</span><i /> <span>CONNECT</span><i /> <span>RECALL</span></div>
      </section>

      <section className="oge-news-strip" aria-labelledby="news-strip-title">
        <div className="oge-news-label"><span className="oge-news-symbol">◉</span><div><span className="oge-section-kicker">YOUR DAILY BRIEFING</span><h2 id="news-strip-title">News, your way.</h2></div></div>
        <div className="oge-news-copy"><p>Choose your interests during registration to shape a feed around technology, science, business, world events, and more.</p><a href="/news">Explore news <span aria-hidden="true">→</span></a></div>
      </section>

      <section className="oge-module-section" aria-labelledby="modules-title">
        <div className="oge-section-heading"><div><span className="oge-section-kicker">YOUR TOOLKIT</span><h2 id="modules-title">Everything in its place.</h2></div><span className="oge-count">09 MODULES</span></div>
        <div className="hub-grid oge-module-grid">
          {modules.map((item) => (
            <a key={item.href} className={`hub-card oge-module-card${item.featured ? ' hub-card-featured' : ''}`} href={item.href}>
              <div className="oge-module-card-top"><span className="oge-module-icon" aria-hidden="true">{item.icon}</span><span className="hub-card-kicker">{item.number} · {item.group}</span></div>
              <h3>{item.title} <span aria-hidden="true">↗</span></h3>
              <p>{item.description}</p>
              <span className="hub-card-link">Open {item.title} <span aria-hidden="true">→</span></span>
            </a>
          ))}
        </div>
      </section>

      <footer className="oge-footer"><a className="oge-brand oge-footer-brand" href="/"><span className="oge-brand-mark">O</span><span>OgeNotes</span></a><span>A little more organized, every day.</span><a href="/settings">Settings <span aria-hidden="true">↗</span></a></footer>
    </main>
  );
}
