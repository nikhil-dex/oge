import { redirect } from 'next/navigation';
import { auth } from '../../auth.js';
import { getDatabase } from '../../lib/mongodb.js';
import { ownerMutationFilter } from '../../lib/active-owner-mutation.js';
import { standaloneNotesDestination } from '../../lib/oge-vault-workspace-routing.js';

export const dynamic = 'force-dynamic';

/**
 * M107: a connected Vault owner gets one real Note-writing destination.
 * The original AirNotes client and legacy APIs remain untouched for
 * accounts that have not enabled GitHub Vault. No content is migrated or
 * silently copied from MongoDB.
 */
export default async function AirNotesLayout({ children }) {
  if (process.env.OGE_VAULT_MAIN_PREVIEW !== 'true' ||
      process.env.OGE_VAULT_HYBRID_DRAFT_PREVIEW !== 'true')
    return children;
  const session = await auth();
  if (!session?.user?.id) return children;
  const db = await getDatabase();
  const account = await db.collection('users').findOne(
    ownerMutationFilter(session.user.id, {
      sessionVersion: session.user.sessionVersion,
    }), { projection: { vault: 1 } },
  );
  if (!account) redirect('/register');
  const destination = standaloneNotesDestination(account);
  if (destination) redirect(destination);
  return children;
}
