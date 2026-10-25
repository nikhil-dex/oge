const featureDetails = {
  notes: { title: 'Notes', description: 'Your organized space for study notes and ideas.', phase: 'Core notes and editing are planned for Phase 3.' },
  airnotes: { title: 'AirNotes', description: 'A dedicated space for your AirNotes workflow.', phase: 'The intended AirNotes behavior will be confirmed during repository inventory.' },
  'quick-notes': { title: 'Quick Notes', description: 'Capture a thought quickly and come back to it later.', phase: 'Quick Notes will be implemented in Phase 3.' },
  'saved-links': { title: 'Saved Links', description: 'Keep useful websites and references together.', phase: 'Saved Links will be implemented in Phase 3.' },
  extension: { title: 'Browser Extension', description: 'Save useful links from your browser to OgeNotes.', phase: 'The extension will be developed and authenticated separately in Phase 4.' },
  'revision-history': { title: 'Revision History', description: 'Review previous study activity and revision records.', phase: 'Revision History will be implemented in Phase 3.' },
  dictionary: { title: 'Dictionary', description: 'Look up definitions and learn new words.', phase: 'A licensed dictionary source will be selected in Phase 4.' },
  news: { title: 'News', description: 'A news feed personalized to your interests.', phase: 'News provider selection and interest personalization are planned for Phase 4.' },
  revision: { title: 'Revision', description: 'Review material and strengthen recall.', phase: 'Revision workflows will be implemented in Phase 3.' },
  register: { title: 'Get started', description: 'Create your OgeNotes profile with Google sign-in.', phase: 'Google OAuth and news-interest onboarding are planned for Phase 2.' },
  settings: { title: 'Settings', description: 'Manage your profile, preferences, and news interests.', phase: 'Profile and preferences will be added as the related features are implemented.' },
};

export function generateMetadata({ params }) {
  return params.then(({ feature }) => ({ title: featureDetails[feature]?.title || 'Coming soon' }));
}

export default async function FeaturePage({ params }) {
  const { feature } = await params;
  const item = featureDetails[feature];
  if (!item) return <main className="shell oge-placeholder"><a className="oge-back-link" href="/">← Back to home</a><span className="oge-section-kicker">OGENOTES</span><h1>Page not found</h1><p>This destination does not exist yet.</p></main>;
  return (
    <main className="shell oge-placeholder">
      <a className="oge-back-link" href="/">← Back to dashboard</a>
      <div className="oge-eyebrow"><span className="oge-status-dot" /> OGENOTES · IN DEVELOPMENT</div>
      <span className="oge-section-kicker">YOUR KNOWLEDGE SPACE</span>
      <h1>{item.title}</h1>
      <p className="oge-placeholder-copy">{item.description}</p>
      <div className="oge-placeholder-note"><span className="oge-status-dot" /><p>{item.phase}</p></div>
      <a className="oge-primary-link" href="/">Return to dashboard <span aria-hidden="true">→</span></a>
    </main>
  );
}
