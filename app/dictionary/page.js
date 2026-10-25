import EnglishWordExplainer from '../components/english-word-explainer';
import ThemeToggle from '../components/theme-toggle';

export const metadata = { title: 'Dictionary' };

export default function DictionaryPage() {
  return (
    <main className="shell oge-shell oge-feature-page">
      <header className="oge-topbar"><a className="oge-brand" href="/"><span className="oge-brand-mark">O</span><span>OgeNotes</span></a><nav className="oge-nav" aria-label="Main navigation"><a href="/">Home</a><a href="/notes">Notes</a><a href="/news">News</a></nav><div className="oge-top-actions"><a className="oge-signin" href="/settings">Settings ↗</a><ThemeToggle /></div></header>
      <section className="oge-notes-hero"><div className="oge-eyebrow"><span className="oge-status-dot" /> BUILD YOUR VOCABULARY</div><h1>Find the <span>right words.</span></h1><p className="oge-hero-copy">Explore definitions, pronunciation, examples, and related words from dictionary sources.</p></section>
      <section className="oge-dictionary-wrap"><EnglishWordExplainer /></section>
      <footer className="oge-footer"><a className="oge-brand oge-footer-brand" href="/"><span className="oge-brand-mark">O</span><span>OgeNotes</span></a><span>One word at a time.</span><a href="/">Home ↗</a></footer>
    </main>
  );
}
