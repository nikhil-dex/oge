import { auth } from '../../auth.js';
import { redirect } from 'next/navigation';
import { getDatabase } from '../../lib/mongodb.js';
import { ownerMutationFilter } from '../../lib/active-owner-mutation.js';
import { vaultCaptureAvailable } from '../../lib/oge-vault-workspace-routing.js';
import QuickNotesClient from './quick-notes-client';

export const metadata = { title: 'Quick Notes' };
export const dynamic = 'force-dynamic';

export default async function QuickNotesPage() {
  const session = await auth();
  let apiPath = '/api/quick-notes';
  if (session?.user?.id) {
    const db = await getDatabase();
    const account = await db.collection('users').findOne(
      ownerMutationFilter(session.user.id, {
        sessionVersion: session.user.sessionVersion,
      }), { projection: { vault: 1, notesStorage: 1 } },
    );
    if (!account) redirect('/register');
    if (account.notesStorage === 'unselected') redirect('/onboarding');
    if (account.notesStorage !== 'mongodb') {
      if (!vaultCaptureAvailable(account)) redirect('/vault?setup=onboarding');
      apiPath = '/api/vault/quick-notes';
    }
  }
  // This is the original Oge Quick Notes page; storage is selected on
  // the server, and GitHub users never write through the MongoDB API.
  return <QuickNotesClient apiPath={apiPath} />;
}
