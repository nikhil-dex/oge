import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '../../../auth.js';
import { getDatabase } from '../../../lib/mongodb.js';
import { ownerMutationFilter } from '../../../lib/active-owner-mutation.js';
import SiteNavbar from '../../components/site-navbar';
import VaultPreviewClient from '../vault-preview-client.js';

export const metadata = { title: 'GitHub Notes Preview' };
export const dynamic = 'force-dynamic';

export default async function VaultPreviewPage() {
  if (process.env.OGE_VAULT_NOTE_API_PREVIEW !== 'true') redirect('/vault');
  const session = await auth();
  if (!session?.user?.id) redirect('/register');
  const db = await getDatabase();
  const account = await db.collection('users').findOne(
    ownerMutationFilter(session.user.id, { sessionVersion: session.user.sessionVersion }),
    { projection: { vault: 1 } },
  );
  if (!account) redirect('/register');
  if (account.vault?.status !== 'connected' ||
      !Number.isSafeInteger(account.vault.repoId)) redirect('/vault');

  // A connected user should see the familiar Oge Notes page, never an
  // obsolete preview-branded editor. Keep the original B3 preview source
  // only for isolated scenarios where the main Notes workspace is disabled.
  if (process.env.OGE_VAULT_MAIN_PREVIEW === 'true')
    redirect('/vault/notes');

  return (
    <main className="shell oge-shell oge-retro-workspace oge-vault-page">
      <SiteNavbar actions={<Link className="oge-signin" href="/vault">Oge Vault →</Link>}/>
      <div className="oge-retro-workspace-ribbon" aria-hidden="true">
        <span>✳ OGE / PRIVATE NOTES</span><span>STAGING PREVIEW · GITHUB ONLY</span>
      </div>
      <section className="oge-settings-hero">
        <p className="oge-eyebrow"><span className="oge-status-dot"/> EXPERIMENTAL STORAGE · B3</p>
        <h1>GitHub notes<span>.</span></h1>
        <p>Preview automatic GitHub synchronization and recoverable drafts. This is not the production Notes workspace.</p>
      </section>
      <VaultPreviewClient ownerId={session.user.id} repoId={account.vault.repoId}/>
    </main>
  );
}
