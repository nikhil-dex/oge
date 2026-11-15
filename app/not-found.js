import Link from 'next/link';
export default function NotFound() {
  return <main className="shell oge-placeholder"><span className="oge-section-kicker">404 · NOT FOUND</span><h1>This page isn&apos;t here.</h1><p className="oge-placeholder-copy">The link may be outdated or the page may not exist yet.</p><Link className="oge-primary-link" href="/">Return to OgeNotes →</Link></main>;
}
