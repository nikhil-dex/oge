import { auth } from '../../../../../auth.js';
import { getDatabase } from '../../../../../lib/mongodb.js';
import { getVaultNoteClient } from '../../../../../lib/oge-vault-notes.js';
import { inspectVaultSubject } from '../../../../../lib/oge-vault-subject-preflight.js';
import { VaultGitHubError } from '../../../../../lib/oge-vault-github.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (data, status = 200) => Response.json(data, {
  status, headers: { 'Cache-Control': 'no-store' },
});

// Read-only staging diagnostic. This route does NOT authorize or perform
// cross-store deletion: stale preflight results cannot grant delete access.
export async function GET(request) {
  if (process.env.OGE_VAULT_MAIN_PREVIEW !== 'true' ||
      process.env.OGE_VAULT_HYBRID_DRAFT_PREVIEW !== 'true')
    return json({ error: 'Subject preflight disabled.' }, 404);

  const session = await auth();
  if (!session?.user?.id) return json({ error: 'Sign in required.' }, 401);
  const slug = new URL(request.url).searchParams.get('subject');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(slug || ''))
    return json({ error: 'Invalid subject.' }, 400);

  try {
    const db = await getDatabase();
    const ownerId = session.user.id;
    const subject = await db.collection('subjects').findOne({ ownerId, slug },
      { projection: { _id: 1 } });
    if (!subject) return json({ error: 'Subject not found.' }, 404);
    const client = await getVaultNoteClient(db, {
      ownerId, sessionVersion: session.user.sessionVersion,
    });
    const result = await inspectVaultSubject(client, db.collection('vault_drafts'), {
      ownerId, repoId: client.vault.repoId, subjectId: slug,
    });
    return json({ ...result, advisoryOnly: true });
  } catch (error) {
    if (error instanceof VaultGitHubError) {
      return json({ error: error.message }, error.status === 401 ? 401 :
        error.status === 409 ? 409 : 503);
    }
    console.error('Vault subject preflight failed:', error?.name);
    return json({ error: 'Cannot verify safe subject deletion.' }, 503);
  }
}
