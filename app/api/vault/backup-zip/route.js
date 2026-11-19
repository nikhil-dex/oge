import { auth } from '../../../../auth.js';
import { getDatabase } from '../../../../lib/mongodb.js';
import { ownerMutationFilter } from '../../../../lib/active-owner-mutation.js';
import { getVaultNoteClient } from '../../../../lib/oge-vault-notes.js';
import { githubVaultFilesEnabled } from '../../../../lib/oge-vault-media-validation.js';

// Redirect to GitHub's native repository ZIP download. GitHub may ask the
// owner to sign in before downloading their private repository.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await auth();
  if (!session?.user?.id)
    return Response.json({ error: 'Sign in to download your Vault.' }, { status: 401 });

  const db = await getDatabase();
  const ownerId = session.user.id;
  const sessionVersion = session.user.sessionVersion;
  const account = await db.collection('users').findOne(
    ownerMutationFilter(ownerId, { sessionVersion }),
    { projection: { notesStorage: 1, vault: 1 } },
  );
  if (!account || !githubVaultFilesEnabled(account))
    return Response.json({ error: 'Connect GitHub Vault before downloading its ZIP.' }, { status: 403 });

  try {
    const client = await getVaultNoteClient(db, { ownerId, sessionVersion }, { readOnly: true });
    const repo = encodeURIComponent(client.vault.githubLogin) + '/' +
      encodeURIComponent(client.vault.repoName);
    const branch = client.branch.split('/').map(encodeURIComponent).join('/');
    return new Response(null, {
      status: 302,
      headers: {
        Location: 'https://github.com/' + repo + '/archive/refs/heads/' + branch + '.zip',
        'Cache-Control': 'private, no-store',
        'Referrer-Policy': 'no-referrer',
      },
    });
  } catch {
    return Response.json({ error: 'Vault ZIP download is temporarily unavailable. Try again after reconnecting GitHub.' }, {
      status: 503, headers: { 'Cache-Control': 'private, no-store' },
    });
  }
}
