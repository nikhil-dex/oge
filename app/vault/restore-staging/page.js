import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { auth } from '../../../auth.js';
import { checkVaultStagingReadiness } from '../../../lib/oge-vault-staging-preflight.js';
import SiteNavbar from '../../components/site-navbar.js';
import RestoreReviewClient from './restore-review-client.js';
import styles from './restore-staging.module.css';

export const metadata = { title: 'Staging restore review' };
export const dynamic = 'force-dynamic';

function stagingAllowed(env) {
  if (env.OGE_VAULT_CHUNK_RESTORE_APPROVAL_PREVIEW !== 'true' ||
      env.OGE_VAULT_MAIN_PREVIEW !== 'true' ||
      !/^oge_vault_restore_staging_[a-zA-Z0-9_]{1,36}$/.test(
        env.MONGODB_DB || '') ||
      !checkVaultStagingReadiness(env).ok) return false;
  try {
    const site = new URL(env.OGE_STAGING_URL);
    const vault = new URL(env.OGE_VAULT_BASE_URL);
    return site.protocol === 'https:' && site.origin === vault.origin;
  } catch { return false; }
}

/**
 * M62: Hidden staging-only owner-facing approval review.
 * No server props carry note content, GitHub tokens or backup chunks.
 * Route is 404 outside the isolated M59 staging environment.
 */
export default async function RestoreStagingPage() {
  if (!stagingAllowed(process.env)) notFound();
  const session = await auth();
  if (!session?.user?.id) redirect('/register');
  return (
    <main className={'shell oge-shell oge-retro-workspace ' + styles.page}>
      <SiteNavbar actions={<Link className="oge-signin" href="/vault">
        Back to private Vault →</Link>} />
      <div className="oge-retro-workspace-ribbon" aria-hidden="true">
        <span>✳ OGE / PRIVATE ARCHIVE</span>
        <span>ISOLATED STAGING ONLY · NO LIVE RESTORE</span>
      </div>
      <section className="oge-settings-hero">
        <p className="oge-eyebrow"><span className="oge-status-dot" />
          TEST ENVIRONMENT · RESTORE REVIEW</p>
        <h1>Restore review<span>.</span></h1>
        <p>Review the exact GitHub backup selection and request one short-lived
          operator receipt. This page never uploads notes or restores anything.</p>
      </section>
      <RestoreReviewClient />
    </main>
  );
}
