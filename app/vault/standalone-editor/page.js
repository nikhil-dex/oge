import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { auth } from '../../../auth.js';
import { getDatabase } from '../../../lib/mongodb.js';
import { ownerMutationFilter } from '../../../lib/active-owner-mutation.js';
import { checkVaultStagingReadiness } from '../../../lib/oge-vault-staging-preflight.js';
import SiteNavbar from '../../components/site-navbar.js';
import StandaloneVaultEditor from './standalone-vault-editor.js';

export const metadata = {
  title: 'Oge Vault · Standalone Notes staging editor',
  robots: { index: false, follow: false },
};
export const dynamic = 'force-dynamic';

/**
 * M72 standalone staging editor is independent of the default-off E2/E3
 * API flags and only opens when all three previews are explicitly enabled
 * on an isolated protected HTTPS staging origin with disposable database.
 */
function previewEnabled(env = process.env) {
  return env.OGE_VAULT_STANDALONE_EDITOR_PREVIEW === 'true' &&
    env.OGE_VAULT_STANDALONE_PREVIEW === 'true' &&
    env.OGE_VAULT_STANDALONE_DRAFT_PREVIEW === 'true' &&
    env.OGE_VAULT_MAIN_PREVIEW === 'true' &&
    env.OGE_VAULT_NOTE_API_PREVIEW === 'true' &&
    env.OGE_VAULT_HYBRID_DRAFT_PREVIEW === 'true' &&
    /^oge_vault_restore_staging_[a-zA-Z0-9_]{1,36}$/.test(env.MONGODB_DB || '') &&
    env.OGE_ACCOUNT_DELETION_ENABLED !== 'true' &&
    env.OGE_VAULT_DESTRUCTIVE_DELETE_INTERNAL !== 'true' &&
    env.OGE_VAULT_SUBJECT_RETIRE_INTERNAL !== 'true' &&
    env.OGE_STAGING_URL === env.AUTH_URL &&
    checkVaultStagingReadiness(env).ok;
}

export default async function VaultStandaloneStagingPage() {
  if (!previewEnabled()) notFound();
  const session = await auth();
  if (!session?.user?.id) redirect('/register');
  const db = await getDatabase();
  const account = await db.collection('users').findOne(
    ownerMutationFilter(session.user.id, {
      sessionVersion: session.user.sessionVersion,
    }), { projection: { vault: 1 } },
  );
  if (account?.vault?.status !== 'connected' ||
      !Number.isSafeInteger(account.vault.repoId) ||
      account.vault.repoId < 1 ||
      !Number.isSafeInteger(account.vault.installationId) ||
      account.vault.installationId < 1)
    notFound();
  return (
    <main className="shell oge-shell oge-retro-workspace oge-vault-page">
      <SiteNavbar actions={<Link className="oge-signin" href="/vault">
        Back to Oge Vault →
      </Link>} />
      <div className="oge-retro-workspace-ribbon" aria-hidden="true">
        <span>✳ OGE / PRIVATE GITHUB CAPTURES</span>
        <span>STAGING · NO PRODUCTION DATA</span>
      </div>
      <section className="oge-settings-hero">
        <p className="oge-eyebrow"><span className="oge-status-dot" />
          ENCRYPTED TEMPORARY AUTOSAVE
        </p>
        <h1>Quick Notes &amp; AirNotes<span>.</span></h1>
        <p>Review your GitHub-backed standalone captures. Draft autosave is
          encrypted and temporary; only the Save button creates a verified
          private GitHub version. This is not the production editor.</p>
      </section>
      <StandaloneVaultEditor
        ownerId={session.user.id} repoId={account.vault.repoId} />
    </main>
  );
}
