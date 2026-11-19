import { auth } from '../../auth.js';
import { getDatabase } from '../../lib/mongodb.js';
import { ownerMutationFilter } from '../../lib/active-owner-mutation.js';
import { vaultCaptureAvailable } from '../../lib/oge-vault-workspace-routing.js';
import PersonalQuickNotesPanel from '../components/personal-quick-notes-panel';

export const metadata = { title: 'AirNotes' };
export const dynamic = 'force-dynamic';

export default async function AirNotesPage() {
  const session = await auth();
  let apiPath = '/api/personal-quick-notes';
  if (session?.user?.id) {
    const db = await getDatabase();
    const account = await db.collection('users').findOne(
      ownerMutationFilter(session.user.id, {
        sessionVersion: session.user.sessionVersion,
      }), { projection: { vault: 1, notesStorage: 1 } },
    );
    if (account?.notesStorage !== 'mongodb' && vaultCaptureAvailable(account))
      apiPath = '/api/vault/airnotes';
  }

  // Same original Oge AirNotes component, presentation and interactions;
  // only the selected owner-scoped storage API changes.
  return <main className="shell quick-notes-shell">
    <PersonalQuickNotesPanel fullPage apiPath={apiPath} />
  </main>;
}
