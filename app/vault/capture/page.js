import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { auth } from '../../../auth.js';
import { getDatabase } from '../../../lib/mongodb.js';
import { ownerMutationFilter } from '../../../lib/active-owner-mutation.js';
import { checkVaultStagingReadiness } from '../../../lib/oge-vault-staging-preflight.js';
import SiteNavbar from '../../components/site-navbar.js';
import VaultQuickCaptureClient from './vault-quick-capture-client.js';

export const metadata = {
  title: 'Oge Vault · Quick Capture staging preview',
  robots: { index: false, follow: false },
};
export const dynamic = 'force-dynamic';

function enabled(env = process.env) {
  return env.OGE_VAULT_QUICK_CAPTURE_PREVIEW === 'true' &&
    env.OGE_VAULT_MAIN_PREVIEW === 'true' &&
    env.OGE_VAULT_NOTE_API_PREVIEW === 'true' &&
    env.OGE_VAULT_HYBRID_DRAFT_PREVIEW === 'true' &&
    /^oge_vault_restore_staging_[a-zA-Z0-9_]{1,36}$/.test(env.MONGODB_DB || '') &&
    env.OGE_VAULT_CUTOVER_GUARD_PREVIEW !== 'true' &&
    env.OGE_VAULT_DESTRUCTIVE_DELETE_INTERNAL !== 'true' &&
    env.OGE_ACCOUNT_DELETION_ENABLED !== 'true' &&
    checkVaultStagingReadiness(env).ok &&
    env.OGE_STAGING_URL === env.AUTH_URL;
}

/**
 * E1: isolated staging-only owner browser capture. Reuses existing
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
      <SiteNavbar actions={
        <Link href="/vault" className="oge-signin">Back to private Vault →</Link>
      } />
      <div className="oge-retro-workspace-ribbon" aria-hidden="true">
        <span>✳ OGE / QUICK CAPTURE</span>
        <span>ISOLATED STAGING · EXPLICIT SAVE</span>
      </div>
      <section className="oge-settings-hero">
        <p className="oge-eyebrow"><span className="oge-status-dot" />
          ENCRYPTED AUTOSAVE · PRIVATE GITHUB
        </p>
        <h1>Capture<span>.</span></h1>
        <p>Fast, subject-based notes, with temporary encrypted drafts and
          explicit GitHub-backed Save. This pilot does not change standalone
          Quick Notes, AirNotes or the browser extension.</p>
      </section>
      <VaultQuickCaptureClient
        ownerId={session.user.id} repoId={user.vault.repoId} />
    </main>
  );
}
