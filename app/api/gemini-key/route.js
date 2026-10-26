import { auth } from '../../../auth.js';
import { getDatabase } from '../../../lib/mongodb.js';
import { readLimitedBody } from '../../../lib/read-limited-body.js';
import { encryptGeminiKey, maskGeminiKey } from '../../../lib/gemini-key.js';

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

const FREE_GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash'];

async function verifyGeminiKey(apiKey) {
  let lastStatus = 0;
  let lastFinishReason = '';
  for (const model of FREE_GEMINI_MODELS) {
    let response;
    try {
      response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        cache: 'no-store',
        signal: AbortSignal.timeout(12000),
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: OgeNotes connection successful.' }] }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 64,
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'OBJECT',
              properties: { message: { type: 'STRING' } },
              required: ['message'],
              propertyOrdering: ['message'],
            },
          },
        }),
      });
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        lastStatus = 504;
        continue;
      }
      throw error;
    }

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      lastStatus = response.status;
      if (response.status === 401 || response.status === 403) {
        throw new Error('Gemini rejected this API key. Check the key and its API access.');
      }
      if ([404, 429, 500, 502, 503, 504].includes(response.status)) continue;
      const detail = typeof payload?.error?.message === 'string'
        ? payload.error.message.replace(/[\\r\\n]+/g, ' ').slice(0, 180)
        : '';
      throw new Error('Gemini connection failed (' + response.status + ').' + (detail ? ' ' + detail : ' Check the API response and key permissions.'));
    }

    const candidate = payload?.candidates?.[0];
    const output = candidate?.content?.parts?.map((part) => part.text || '').join('').trim();
    if (output) {
      try {
        const parsed = JSON.parse(output);
        if (typeof parsed.message === 'string' && parsed.message.trim()) return;
      } catch { /* Try the fallback model if the provider returned malformed output. */ }
    }
    lastFinishReason = String(candidate?.finishReason || '');
  }

  if (lastStatus === 429) {
    throw new Error('Free Gemini model quotas or rate limits are exhausted. Check your Google AI Studio quota and try again later.');
  }
  if (lastStatus === 404) {
    throw new Error('Neither configured Gemini model is available to this key. Check the models listed for your key in the Gemini Models API.');
  }
  if (lastFinishReason) {
    throw new Error('Gemini accepted the key but returned no usable test text (finish reason: ' + lastFinishReason + '). Try again or check model access.');
  }
  throw new Error('No configured free Gemini model returned a usable response. Try again later.');
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
    if (!apiKey || apiKey.length < 10 || apiKey.length > 512 || /\s/.test(apiKey)) {
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
