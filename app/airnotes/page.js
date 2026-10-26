import PersonalQuickNotesPanel from '../components/personal-quick-notes-panel';

export const metadata = { title: 'AirNotes' };

export default function AirNotesPage() {
  return <main className="shell quick-notes-shell"><PersonalQuickNotesPanel fullPage /></main>;
}
