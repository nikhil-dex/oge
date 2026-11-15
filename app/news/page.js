import Link from 'next/link';
import HomeNewsFeed from '../components/home-news-feed';
import ThemeToggle from '../components/theme-toggle';

export const metadata = { title: 'News' };

export default function NewsPage() {
  return (
    <main className="shell oge-shell oge-feature-page">
      <header className="oge-topbar"><Link className="oge-brand" href="/"><span className="oge-brand-mark">O</span><span>OgeNotes</span></Link><nav className="oge-nav" aria-label="Main navigation"><Link href="/">Home</Link><Link href="/notes">Notes</Link><Link className="is-active" href="/news">News</Link></nav><div className="oge-top-actions"><Link className="oge-signin" href="/settings">Settings ↗</Link><ThemeToggle /></div></header>
      <HomeNewsFeed />
      <footer className="oge-footer"><Link className="oge-brand oge-footer-brand" href="/"><span className="oge-brand-mark">O</span><span>OgeNotes</span></Link><span>A better-informed day.</span><Link href="/settings">News settings ↗</Link></footer>
    </main>
  );
}
