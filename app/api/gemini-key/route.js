import { auth } from '../../../auth.js';
import { getDatabase } from '../../../lib/mongodb.js';
import { readLimitedBody } from '../../../lib/read-limited-body.js';
import { encryptGeminiKey } from '../../../lib/gemini-key.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function context() {
  const session = await auth();
  if (!session?.user?.id) return null;
  return { db: await getDatabase(), ownerId: session.user.id };
}

async function readBody(request) {
  try {
    return JSON.parse(await readLimitedBody(request, 8 * 1024));
  } catch (error) {
    throw new Error(error?.status === 413 ? 'Request body is too large.' : 'Enter valid JSON.');
  }
}

async function verifyGeminiKey(apiKey) {
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    cache: 'no-store',
    signal: AbortSignal.timeout(12000),
    body: JSON.stringify({
      contents: [{ parts: [{ text: 'Reply with exactly: OgeNotes connection successful.' }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 24 },
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error('Gemini rejected this API key. Check the key and its API access.');
    if (response.status === 429) throw new Error('Gemini rate limit or quota reached. Check your Google AI Studio quota and billing settings.');
    throw new Error('Gemini connection failed (' + response.status + '). Check that the Gemini API is enabled for this key.');
  }
  if (!payload?.candidates?.[0]?.content?.parts?.some((part) => typeof part.text === 'string')) {
    throw new Error('Gemini did not return a valid response. Try again.');
  }
}

export async function GET() {
  try {
    const ctx = await context();
    if (!ctx) return json({ error: 'Sign in to manage your Gemini API key.' }, 401);
    const user = await ctx.db.collection('users').findOne(
      { googleSub: ctx.ownerId },
      { projection: { geminiApiKey: 1 } },
    );
    const stored = user?.geminiApiKey;
    return json({
      configured: Boolean(stored?.ciphertext && stored?.iv && stored?.tag),
      updatedAt: stored?.updatedAt || null,
    });
  } catch (error) {
    console.error('GET /api/gemini-key failed:', error?.name);
    return json({ error: 'Could not load Gemini key status.' }, 500);
  }
}

export async function POST(request) {
  let ctx;
  try {
    ctx = await context();
    if (!ctx) return json({ error: 'Sign in to manage your Gemini API key.' }, 401);
    const data = await readBody(request);
    const action = String(data?.action || '');
    const users = ctx.db.collection('users');

    if (action === 'delete') {
      await users.updateOne({ googleSub: ctx.ownerId }, { $unset: { geminiApiKey: '' } });
      return json({ configured: false, message: 'Gemini API key removed.' });
    }

    const apiKey = String(data?.apiKey || '').trim();
    if (!apiKey || apiKey.length > 512 || !/^AIza[\w-]{20,}$/.test(apiKey)) {
      return json({ error: 'Enter a valid-looking Google Gemini API key.' }, 400);
    }

    await verifyGeminiKey(apiKey);
    if (action === 'test') return json({ valid: true, message: 'Gemini connection successful. The key was not saved.' });
    if (action !== 'save') return json({ error: 'Choose save, test, or delete.' }, 400);

    const encrypted = encryptGeminiKey(apiKey);
    await users.updateOne({ googleSub: ctx.ownerId }, { $set: { geminiApiKey: encrypted, updatedAt: new Date() } });
    return json({ configured: true, updatedAt: encrypted.updatedAt, maskedKey: maskGeminiKey(apiKey), message: 'Gemini API key saved securely.' });
  } catch (error) {
    if (error?.message === 'GEMINI_KEY_ENCRYPTION_SECRET must be configured with at least 32 characters.') {
      return json({ error: 'Gemini BYOK is not configured on this deployment yet. Set GEMINI_KEY_ENCRYPTION_SECRET on the server.' }, 503);
    }
    if (error?.message?.startsWith('Gemini ') || error?.message?.startsWith('Enter a valid') || error?.message?.startsWith('Request body')) {
      return json({ error: error.message }, 400);
    }
    console.error('POST /api/gemini-key failed:', error?.name);
    return json({ error: 'Could not update Gemini API key.' }, 500);
  }
}
