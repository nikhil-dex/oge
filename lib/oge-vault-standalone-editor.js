/**
 * E4/M72 — browser-only standalone Vault editor keys and safe data handling.
 * Never rely on browser storage for authenticated access or GitHub provenance.
 * The entire sessionStorage namespace is bound to the signed account and
 * verified private repository ID passed by the server-side staging page.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/;
const KINDS = new Set(['quick-notes', 'airnotes']);

export function captureEditorScope(ownerId, repoId, kind, id = null) {
  if (typeof ownerId !== 'string' || !ownerId || ownerId.length > 120 ||
      !Number.isSafeInteger(repoId) || repoId < 1 || !KINDS.has(kind) ||
      (id !== null && (typeof id !== 'string' || !UUID.test(id))))
    throw new TypeError('Invalid standalone editor scope');
  const prefix = 'oge-vault-standalone-session:v1:' +
    encodeURIComponent(ownerId) + ':' + repoId + ':' + kind;
  return id === null ? prefix + ':last-new' : prefix + ':' + id.toLowerCase();
}

export function normalizeEditorContent(value) {
  if (typeof value !== 'string' || value.length > 20000)
    throw new TypeError('Standalone capture must be 20,000 characters or fewer.');
  const content = value.replace(/\r\n?/g, '\n');
  // Conservative client limit: server independently validates final
  // canonical JSON <= 32 KiB. Do not send oversized drafts.
  if (new TextEncoder().encode(content).length > 30 * 1024)
    throw new TypeError('Standalone capture exceeds the safe UTF-8 file limit.');
  return content;
}

export function encodeLocalRecovery(editor) {
  if (!editor || !KINDS.has(editor.kind) ||
      typeof editor.id !== 'string' || !UUID.test(editor.id) ||
      (editor.baseSha !== null &&
        (typeof editor.baseSha !== 'string' || !SHA.test(editor.baseSha))))
    throw new TypeError('Invalid local recovery entry');
  const content = normalizeEditorContent(editor.content);
  return JSON.stringify({
    version: 1, kind: editor.kind, id: editor.id.toLowerCase(),
    baseSha: editor.baseSha, content,
  });
}

export function parseLocalRecovery(raw, kind, id) {
  if (typeof raw !== 'string' || raw.length > 40 * 1024 ||
      !KINDS.has(kind) || typeof id !== 'string' || !UUID.test(id))
    return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || Object.keys(parsed).sort().join(',') !==
        'baseSha,content,id,kind,version' ||
        parsed.version !== 1 || parsed.kind !== kind ||
        parsed.id !== id.toLowerCase())
      return null;
    if (encodeLocalRecovery(parsed) !== raw) return null;
    return parsed;
  } catch { return null; }
}

/**
 * A GitHub content read can prove current bytes only; it never proves
 * that a particular POST/PATCH was the writer. This is intentionally used
 * only to decide whether read-only draft cleanup MAY be attempted.
 */
export function currentCaptureMatchesPending(pending, read) {
  if (!pending || !read ||
      !KINDS.has(pending.kind) ||
      typeof pending.id !== 'string' || !UUID.test(pending.id) ||
      (pending.baseSha !== null &&
        (typeof pending.baseSha !== 'string' || !SHA.test(pending.baseSha))) ||
      typeof read.sha !== 'string' || !SHA.test(read.sha))
    return false;
  const expectedFormat = pending.kind === 'airnotes'
    ? 'ogenotes-airnote' : 'ogenotes-quick-note';
  if (read.id !== pending.id.toLowerCase() ||
      read.format !== expectedFormat ||
      (read.kind !== undefined && read.kind !== pending.kind) ||
      (pending.baseSha !== null && read.sha === pending.baseSha) ||
      read.content !== pending.content)
    return false;
  return Number.isSafeInteger(pending.revision) && pending.revision >= 1;
}
