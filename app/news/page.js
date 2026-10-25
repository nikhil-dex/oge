import HomeNewsFeed from '../components/home-news-feed';
import ThemeToggle from '../components/theme-toggle';

export const metadata = { title: 'News' };

export default function NewsPage() {
  return (
    <main className="shell oge-shell oge-feature-page">
      <header className="oge-topbar"><a className="oge-brand" href="/"><span className="oge-brand-mark">O</span><span>OgeNotes</span></a><nav className="oge-nav" aria-label="Main navigation"><a href="/">Home</a><a href="/notes">Notes</a><a className="is-active" href="/news">News</a></nav><div className="oge-top-actions"><a className="oge-signin" href="/settings">Settings ↗</a><ThemeToggle /></div></header>
      <HomeNewsFeed />
      <footer className="oge-footer"><a className="oge-brand oge-footer-brand" href="/"><span className="oge-brand-mark">O</span><span>OgeNotes</span></a><span>A better-informed day.</span><a href="/settings">News settings ↗</a></footer>
    </main>
  );
}
