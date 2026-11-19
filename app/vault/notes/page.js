import { redirect } from 'next/navigation';
import { auth } from '../../../auth.js';
import { getDatabase } from '../../../lib/mongodb.js';
import { ownerMutationFilter } from '../../../lib/active-owner-mutation.js';
import NotesPage from '../../notes/page.js';
import { vaultNotesAvailable } from '../../../lib/oge-vault-workspace-routing.js';

export const metadata = { title: 'Oge · Notes' };
export const dynamic = 'force-dynamic';

/**
 * This is the existing Notes interface, but every Notes CRUD request goes
 * through the GitHub-only preview adapter. The production /notes page remains
 * unchanged until Quick Notes, AirNotes, extension, backup and revision
 * routes all use GitHub too.
 */
export default async function VaultNotesPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/register');
  const db = await getDatabase();
  const user = await db.collection('users').findOne(
    ownerMutationFilter(session.user.id, { sessionVersion: session.user.sessionVersion }),
    { projection: { vault: 1, notesStorage: 1 } },
  );
  if (!vaultNotesAvailable(user)) redirect('/vault?setup=onboarding');
  const hybridDrafts = process.env.OGE_VAULT_HYBRID_DRAFT_PREVIEW === 'true';
  // Render the original Oge Notes workspace directly. GitHub is the
  // storage provider, not a separate preview-branded product interface.
  return <NotesPage notesApi="/api/vault/notes-main" vaultMode hybridDrafts={hybridDrafts}
    vaultOwnerId={session.user.id} vaultRepoId={user.vault.repoId} />;
}
