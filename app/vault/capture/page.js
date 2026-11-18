import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { auth } from '../../../auth.js';
import { getDatabase } from '../../../lib/mongodb.js';
import { ownerMutationFilter } from '../../../lib/active-owner-mutation.js';
import SiteNavbar from '../../components/site-navbar.js';
import VaultQuickCaptureClient from './vault-quick-capture-client.js';

export const metadata = {
  title: 'Oge Vault · Quick Capture',
  robots: { index: false, follow: false },
};
export const dynamic = 'force-dynamic';

function enabled(env = process.env) {
  // The regular connected GitHub Notes editor and its draft API are all
  // Quick Capture needs. A second staging-only opt-in made the button unusable.
  return env.OGE_VAULT_MAIN_PREVIEW === 'true' &&
    env.OGE_VAULT_HYBRID_DRAFT_PREVIEW === 'true';
}

/**
 * E1: connected owner browser capture. Reuses existing
 * authenticated hybrid draft PUT and verified GitHub Notes-main POST.
 * NO new API endpoints, no extension token to GitHub authorization bridge.
 * The default production Quick Notes/AirNotes paths remain unchanged.
 */
export default async function VaultQuickCapturePage() {
  if (!enabled()) notFound();
  const session = await auth();
  if (!session?.user?.id) redirect('/register');
  const db = await getDatabase();
  const user = await db.collection('users').findOne(
    ownerMutationFilter(session.user.id, {
      sessionVersion: session.user.sessionVersion,
    }), { projection: { vault: 1 } },
  );
  if (user?.vault?.status !== 'connected' ||
      !Number.isSafeInteger(user.vault.repoId) || user.vault.repoId <= 0 ||
      !Number.isSafeInteger(user.vault.installationId) ||
      user.vault.installationId <= 0)
    notFound();

  return (
    <main className="shell oge-shell oge-retro-workspace oge-vault-page">
      <SiteNavbar notesHref="/vault/notes" actions={
        <Link href="/vault/notes" className="oge-signin">All GitHub Notes →</Link>
      } />
      <div className="oge-retro-workspace-ribbon" aria-hidden="true">
        <span>✳ OGE / QUICK CAPTURE</span>
        <span>CAPTURE · SAVE WHEN READY</span>
      </div>
      <section className="oge-settings-hero">
        <p className="oge-eyebrow"><span className="oge-status-dot" />
          ENCRYPTED AUTOSAVE · PRIVATE GITHUB
        </p>
        <h1>Capture<span>.</span></h1>
        <p>Fast, subject-based notes, with temporary encrypted drafts and
          explicit GitHub-backed Save. Write a single thought, or put the title on the first line and details below it.</p>
      </section>
      <VaultQuickCaptureClient
        ownerId={session.user.id} repoId={user.vault.repoId} />
    </main>
  );
}
