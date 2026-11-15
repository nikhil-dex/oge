import { headers } from 'next/headers';
import './globals.css';
import '../public/style.css';
import '../public/extra.css';
import '../public/news.css';

export const metadata = {
  title: { default: 'OgeNotes', template: '%s | OgeNotes' },
  description: 'Your personal knowledge and study dashboard.',
};

export default async function RootLayout({ children }) {
  // Dynamic rendering allows each response to use its own nonce.
  const nonce = (await headers()).get('x-nonce') || undefined;
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: "try { document.documentElement.dataset.theme = localStorage.getItem('theme') || 'dark'; } catch { document.documentElement.dataset.theme = 'dark'; }" }} />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
      </head>
      <body>{children}</body>
    </html>
  );
}
