import './globals.css';

export const metadata = {
  title: { default: 'OgeNotes', template: '%s | OgeNotes' },
  description: 'Your personal knowledge and study dashboard.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: "try { document.documentElement.dataset.theme = localStorage.getItem('theme') || 'dark'; } catch { document.documentElement.dataset.theme = 'dark'; }" }} />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="stylesheet" href="/style.css" />
        <link rel="stylesheet" href="/extra.css" />
        <link rel="stylesheet" href="/news.css" />
      </head>
      <body>{children}</body>
    </html>
  );
}
