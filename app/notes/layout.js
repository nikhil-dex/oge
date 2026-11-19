import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '../../auth.js';
import { getDatabase } from '../../lib/mongodb.js';
import {
  inspectLegacyCutoverForOwner, legacyNotesWorkspaceDestination,
} from '../../lib/oge-vault-cutover-guard.js';

export const dynamic = 'force-dynamic';

/**
 * Phase D2 staging-only entrypoint. The familiar /notes URL reuses the
 * existing GitHub-only Notes editor for an explicitly connected Vault owner.
 * Never render the legacy client if GitHub/identity checks are inconclusive.
 *
 * This layout has no effect at all while the cutover guard is disabled.
 * The GitHub-only /vault/notes page separately reauthenticates the owner,
 * repo and installation, and its API never falls back to MongoDB content.
 */
export default async function NotesLayout({ children }) {
  const session = await auth();
  if (!session?.user?.id) redirect('/register');
  const db = await getDatabase();
  const decision = await inspectLegacyCutoverForOwner(
    db, session.user.id,
    { sessionVersion: session.user.sessionVersion },
  );
  const destination = legacyNotesWorkspaceDestination(decision);
  if (['vault-storage-setup-required', 'vault-storage-not-ready'].includes(decision.code))
    redirect('/vault?setup=onboarding');
  if (destination === 'vault') redirect('/vault/notes');
  if (destination === 'legacy') return children;

  // Failed configuration, expired account and incomplete Vault connections
  // must never be interpreted as permission to use the MongoDB editor.
  return (
    <main className="shell oge-shell oge-retro-workspace">
      <section className="oge-settings-card" role="alert">
        <h1>Notes workspace temporarily unavailable</h1>
        <p>{decision.error || 'The connected Vault needs review before editing.'}</p>
        <p>Your existing notes and unsaved drafts have not been changed.</p>
        <Link className="oge-primary-link" href="/vault">Check Oge Vault connection</Link>
      </section>
    </main>
  );
}
