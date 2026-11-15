import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '../../../auth.js';
import { getDatabase } from '../../../lib/mongodb.js';
import { ownerMutationFilter } from '../../../lib/active-owner-mutation.js';
import NotesPage from '../../notes/page.js';

export const metadata = { title: 'Oge Vault · Notes workspace preview' };
export const dynamic = 'force-dynamic';

/**
 * This is the existing Notes interface, but every Notes CRUD request goes
 * through the GitHub-only preview adapter. The production /notes page remains
 * unchanged until Quick Notes, AirNotes, extension, backup and revision
 * routes all use GitHub too.
 */
export default async function VaultNotesPage() {
  if (process.env.OGE_VAULT_MAIN_PREVIEW !== 'true') redirect('/vault');
  const session = await auth();
  if (!session?.user?.id) redirect('/register');
  const db = await getDatabase();
  const user = await db.collection('users').findOne(
    ownerMutationFilter(session.user.id, { sessionVersion: session.user.sessionVersion }),
    { projection: { vault: 1 } },
  );
  if (user?.vault?.status !== 'connected') redirect('/vault');
  const hybridDrafts = process.env.OGE_VAULT_HYBRID_DRAFT_PREVIEW === 'true';
  return (
    <>
      <div className="oge-vault-editor-back"><Link href="/vault">← Return to Oge Vault</Link></div>
      <NotesPage notesApi="/api/vault/notes-main" vaultMode hybridDrafts={hybridDrafts}
        vaultOwnerId={session.user.id} vaultRepoId={user.vault.repoId} />
    </>
  );
}
