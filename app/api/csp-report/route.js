// CSP reports are untrusted browser telemetry. Never log document URLs,
// referrers, sample code, or other potentially sensitive report fields.
const MAX_REPORT_BYTES = 8192;
const ALLOWED_DIRECTIVES = /^[a-z][a-z0-9-]{0,63}$/;
// Per-process log budget (not a substitute for CDN/WAF rate limiting).
const LOG_WINDOW_MS = 60_000;
const MAX_LOGS_PER_WINDOW = 20;
let logWindow = 0;
let logsThisWindow = 0;

function logDirective(directive) {
  const window = Math.floor(Date.now() / LOG_WINDOW_MS);
  if (window !== logWindow) { logWindow = window; logsThisWindow = 0; }
  if (logsThisWindow >= MAX_LOGS_PER_WINDOW) return;
  logsThisWindow += 1;
  console.warn('CSP report-only violation', { directive });
}

export async function POST(request) {
  const contentType = request.headers.get('content-type') || '';
  if (!/^(application\/csp-report|application\/reports\+json)(?:;|$)/i.test(contentType)) {
    return new Response(null, { status: 415 });
  }

  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_REPORT_BYTES) {
    return new Response(null, { status: 413 });
  }

  const reader = request.body?.getReader();
  if (!reader) return new Response(null, { status: 400 });
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REPORT_BYTES) {
        await reader.cancel();
        return new Response(null, { status: 413 });
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const reports = Array.isArray(payload) ? payload.slice(0, 5) : [payload];
    for (const item of reports) {
      const report = item?.['csp-report'] ?? item?.body ?? item;
      const directive = report?.['effective-directive'] ?? report?.effectiveDirective;
      if (typeof directive === 'string' && ALLOWED_DIRECTIVES.test(directive)) {
        logDirective(directive);
      }
    }
  } catch {
    return new Response(null, { status: 400 });
  } finally {
    reader.releaseLock();
  }
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}
