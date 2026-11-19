import { redirect } from 'next/navigation';
import { auth } from '../../auth.js';
import { getDatabase } from '../../lib/mongodb.js';
import { ownerMutationFilter } from '../../lib/active-owner-mutation.js';
import { githubVaultFilesEnabled } from '../../lib/oge-vault-media-validation.js';
import MediaLibrary from '../components/media-library';

export const metadata = {
  title: 'My Files',
  description: 'Organize your PDFs, ZIPs and images in your own private GitHub Vault.',
};
export const dynamic = 'force-dynamic';

export default async function FilesPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/register');
  const db = await getDatabase();
  const account = await db.collection('users').findOne(
    ownerMutationFilter(session.user.id, {
      sessionVersion: session.user.sessionVersion,
    }), { projection: { vault: 1, notesStorage: 1 } },
  );
  if (!account) redirect('/register');
  if (!githubVaultFilesEnabled(account)) redirect(
    account.notesStorage === 'github' || account.notesStorage === 'unselected'
      ? '/vault?setup=onboarding' : '/'
  );
  return <main className="shell media-library-shell"><MediaLibrary /></main>;
}
