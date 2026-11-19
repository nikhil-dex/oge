// GitHub Vault stores arbitrary file bytes, not just legacy PDF/ZIP/images.
// A short preview allowlist is separate from what users may upload.
export const MAX_MEDIA_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_MEDIA_FILES = 500;
export const MAX_MEDIA_TOTAL_BYTES = 200 * 1024 * 1024;
export const MAX_MEDIA_FOLDERS = 100;
export const VAULT_MEDIA_CHUNK_BYTES = 2 * 1024 * 1024;
export const MAX_MEDIA_CHUNKS = Math.ceil(MAX_MEDIA_FILE_BYTES / VAULT_MEDIA_CHUNK_BYTES);
export const MEDIA_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

const PREVIEW_TYPES = new Map([
  ['application/pdf', ['.pdf']],
  ['image/jpeg', ['.jpg', '.jpeg']],
  ['image/png', ['.png']],
  ['image/webp', ['.webp']],
]);
const ZIP_EXTENSIONS = ['.zip'];
const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+~-]{0,127}\/[a-z0-9][a-z0-9!#$&^_.+~-]{0,127}$/;

export const isValidMediaId = id => typeof id === 'string' && MEDIA_UUID.test(id);
export const isValidFolderId = id => id == null || id === '' || isValidMediaId(id);

export function normalizeFolderName(value) {
  if (typeof value !== 'string') return { error: 'Folder name must be text.' };
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name || name.length > 80) return { error: 'Folder name must be 1–80 characters.' };
  if (/[\\/\u0000-\u001f\u007f]/.test(name) || name === '.' || name === '..')
    return { error: 'Folder names cannot contain slashes or control characters.' };
  return { value: name };
}

export function normalizeMediaFile(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data))
    return { error: 'Enter valid file details.' };
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  // Browser File.type is often empty for source files and uncommon formats.
  // Keep those bytes as download-only application/octet-stream.
  const type = typeof data.type === 'string' && data.type.trim()
    ? data.type.toLowerCase().trim() : 'application/octet-stream';
  const size = data.size;
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : '';
  if (!name || name.length > 180 || /[\\/\u0000-\u001f\u007f]/.test(name) ||
      name === '.' || name === '..')
    return { error: 'File name must be 1–180 characters and cannot contain path separators.' };
  if (type.length > 255 || !MIME_PATTERN.test(type))
    return { error: 'Invalid file content type.' };
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_MEDIA_FILE_BYTES)
    return { error: 'Files must be between 1 byte and 20 MB.' };
  return { value: { name, type, size, extension } };
}

export function canPreviewMediaFile(file) {
  if (!file || typeof file.name !== 'string') return false;
  const extension = file.name.includes('.')
    ? file.name.slice(file.name.lastIndexOf('.')).toLowerCase() : '';
  return (PREVIEW_TYPES.get(file.type) || []).includes(extension);
}

export function needsMediaSignatureCheck(file) {
  if (canPreviewMediaFile(file)) return true;
  const extension = file?.name?.slice(file.name.lastIndexOf('.')).toLowerCase();
  return file?.type === 'application/zip' && ZIP_EXTENSIONS.includes(extension);
}

export function hasValidMediaSignature(prefix, type) {
  const bytes = Buffer.isBuffer(prefix) ? prefix : Buffer.from(prefix || []);
  if (type === 'application/pdf')
    return bytes.length >= 5 && bytes.subarray(0, 5).toString('ascii') === '%PDF-';
  if (type === 'application/zip')
    return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b &&
      [0x03, 0x05, 0x07].includes(bytes[2]) && [0x04, 0x06, 0x08].includes(bytes[3]);
  if (type === 'image/jpeg')
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === 'image/png')
    return bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (type === 'image/webp')
    return bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  return false;
}

export function githubVaultFilesEnabled(account) {
  return account?.notesStorage !== 'mongodb' &&
    account?.notesStorage !== 'unselected' &&
    account?.vault?.status === 'connected' &&
    Number.isSafeInteger(account?.vault?.repoId) &&
    account.vault.repoId > 0;
}
