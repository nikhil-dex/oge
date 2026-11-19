/**
 * M65 staging-only offline at-rest encryption for current Notes JSON pages.
 *
 * This is portable, versioned, password-based AES-256-GCM encryption using
 * Web Crypto (600k PBKDF2/SHA-256 iterations). Every page is encrypted with
 * an independent random 96-bit IV; one 128-bit salt is shared by one backup
 * set to derive the key once. Header metadata is authenticated as AAD.
 *
 * No Node imports, network, disk, browser storage, GitHub or MongoDB APIs.
 * This protects confidential page bytes at rest, NOT signed GitHub source
 * provenance, backups after source deletion or the recovery write policy.
 */
export const VAULT_OFFLINE_ENCRYPTED_SUFFIX = '.oge.json';
export const VAULT_OFFLINE_KDF_ITERATIONS = 600_000;
export const MAX_VAULT_OFFLINE_PLAINTEXT_BYTES = 4 * 1024 * 1024;
export const MAX_VAULT_OFFLINE_ENVELOPE_BYTES = 6 * 1024 * 1024;
const FORMAT = 'oge-vault-offline-encrypted-notes-part';
const ALGORITHM = 'AES-256-GCM';
const KDF = 'PBKDF2-SHA-256';
const NAME = /^part-(\d{4})\.oge\.json$/;
const HEX = /^[a-f0-9]+$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const LIMIT = 16;
const encoder = new TextEncoder();
const fail = () => { throw new TypeError('Private offline backup is invalid, incomplete or cannot be decrypted.'); };
const bytesToHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const hexToBytes = (hex, size) => {
  if (typeof hex !== 'string' || hex.length !== size * 2 || !HEX.test(hex)) fail();
  return Uint8Array.from({ length: size }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
};
const partName = (part) => 'part-' + String(part).padStart(4, '0');
const canonicalHeader = (value) => ({
  format: value.format,
  version: value.version,
  algorithm: value.algorithm,
  kdf: value.kdf,
  iterations: value.iterations,
  salt: value.salt,
  iv: value.iv,
  part: value.part,
  plainBytes: value.plainBytes,
});

function ensurePassphrase(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 16 ||
      passphrase.length > 256 || passphrase.includes('\0') ||
      encoder.encode(passphrase).byteLength > 1024 ||
      !passphrase.trim()) fail();
}
function ensureCrypto(webCrypto) {
  if (!webCrypto || typeof webCrypto.getRandomValues !== 'function' ||
      typeof webCrypto.subtle?.importKey !== 'function' ||
      typeof webCrypto.subtle?.deriveKey !== 'function' ||
      typeof webCrypto.subtle?.encrypt !== 'function' ||
      typeof webCrypto.subtle?.decrypt !== 'function') fail();
}
async function deriveKey(passphrase, salt, subtle) {
  const base = await subtle.importKey('raw', encoder.encode(passphrase),
    'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({
    name: 'PBKDF2', hash: 'SHA-256', iterations: VAULT_OFFLINE_KDF_ITERATIONS,
    salt,
  }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
function encodeBytes(bytes) {
  // Small aligned chunks avoid "Maximum call stack size exceeded" for
  // 4 MiB encrypted pages and maintain 3-byte base64 boundaries.
  const chunk = 8190, parts = [];
  for (let i = 0; i < bytes.length; i += chunk) {
    let binary = '';
    for (let j = i; j < Math.min(i + chunk, bytes.length); j++)
      binary += String.fromCharCode(bytes[j]);
    parts.push(btoa(binary));
  }
  return parts.join('').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function decodeBytes(encoded) {
  if (typeof encoded !== 'string' || encoded.length < 24 ||
      encoded.length > Math.ceil((MAX_VAULT_OFFLINE_PLAINTEXT_BYTES + 16) * 4 / 3) + 4 ||
      !B64URL.test(encoded) || encoded.length % 4 === 1) fail();
  let value;
  try {
    const text = encoded.replaceAll('-', '+').replaceAll('_', '/');
    value = atob(text.padEnd(Math.ceil(text.length / 4) * 4, '='));
  } catch { fail(); }
  const bytes = Uint8Array.from(value, (char) => char.charCodeAt(0));
  if (encodeBytes(bytes) !== encoded) fail(); // refuse noncanonical encodings
  return bytes;
}
function validateEnvelope(envelope, expectedPart) {
  if (!envelope || typeof envelope !== 'object' ||
      Array.isArray(envelope) ||
      Object.keys(envelope).sort().join(',') !== [
        'format','version','algorithm','kdf','iterations',
        'salt','iv','part','plainBytes','ciphertext',
      ].sort().join(',') ||
      envelope.format !== FORMAT || envelope.version !== 1 ||
      envelope.algorithm !== ALGORITHM || envelope.kdf !== KDF ||
      envelope.iterations !== VAULT_OFFLINE_KDF_ITERATIONS ||
      !Number.isSafeInteger(envelope.part) || envelope.part !== expectedPart ||
      !Number.isSafeInteger(envelope.plainBytes) ||
      envelope.plainBytes < 2 ||
      envelope.plainBytes > MAX_VAULT_OFFLINE_PLAINTEXT_BYTES)
    fail();
  hexToBytes(envelope.salt, 16);
  hexToBytes(envelope.iv, 12);
  if (typeof envelope.ciphertext !== 'string' ||
      envelope.ciphertext.length > MAX_VAULT_OFFLINE_ENVELOPE_BYTES)
    fail();
}
function validatedPartNumber(name, index) {
  const match = NAME.exec(name || '');
  if (!match || Number(match[1]) !== index || index < 1 || index > LIMIT)
    fail();
  return index;
}

/**
 * Create a single owner-initiated encrypted download session.
 * Derive once; use a fresh salt and fresh IV for every page.
 * Only call seal AFTER the M64 chunk verifier accepts a page.
 */
export async function createVaultOfflineEncryptSession(passphrase, {
  webCrypto = globalThis.crypto,
} = {}) {
  ensurePassphrase(passphrase);
  ensureCrypto(webCrypto);
  const salt = new Uint8Array(16);
  webCrypto.getRandomValues(salt);
  const saltHex = bytesToHex(salt);
  const key = await deriveKey(passphrase, salt, webCrypto.subtle);
  const ivs = new Set();
  let nextPart = 1, sealed = false;
  return {
    async seal(text, part) {
      if (sealed || part !== nextPart || !Number.isSafeInteger(part) ||
          part > LIMIT || typeof text !== 'string') fail();
      const plain = encoder.encode(text);
      if (plain.length < 2 || plain.length > MAX_VAULT_OFFLINE_PLAINTEXT_BYTES)
        fail();
      const iv = new Uint8Array(12);
      webCrypto.getRandomValues(iv);
      const ivHex = bytesToHex(iv);
      if (ivs.has(ivHex)) fail();
      ivs.add(ivHex);
      const header = canonicalHeader({
        format: FORMAT, version: 1, algorithm: ALGORITHM, kdf: KDF,
        iterations: VAULT_OFFLINE_KDF_ITERATIONS,
        salt: saltHex, iv: ivHex, part, plainBytes: plain.byteLength,
      });
      const aad = encoder.encode(JSON.stringify(header));
      const encrypted = new Uint8Array(await webCrypto.subtle.encrypt({
        name: 'AES-GCM', iv, additionalData: aad, tagLength: 128,
      }, key, plain));
      const serialized = JSON.stringify({
        ...header, ciphertext: encodeBytes(encrypted),
      });
      if (encoder.encode(serialized).byteLength > MAX_VAULT_OFFLINE_ENVELOPE_BYTES)
        fail();
      nextPart++;
      return { filename: partName(part) + VAULT_OFFLINE_ENCRYPTED_SUFFIX,
        text: serialized, part, plainBytes: plain.byteLength,
        encryptedAtRest: true, signedGitHubProvenance: false };
    },
    close() { sealed = true; },
  };
}

/**
 * Turn a complete set of private encrypted parts into transient File-like
 * views for M63's existing full source+selection verifier.
 * Does NOT dump plaintext to disk or turn encrypted chunks into approval.
 *
 * Each proxy.decrypt is called only when the M63 verifier requests the
 * arrayBuffer; decrypted bytes are not cached across files.
 */
export async function openVaultOfflineEncryptedFiles(files, passphrase, {
  webCrypto = globalThis.crypto,
} = {}) {
  ensurePassphrase(passphrase);
  ensureCrypto(webCrypto);
  if (!files || typeof files.length !== 'number' ||
      files.length < 1 || files.length > LIMIT) fail();
  const ordered = Array.from(files).sort((a, b) =>
    String(a?.name).localeCompare(String(b?.name), 'en'));
  let commonSalt = null, key;
  const knownIVs = new Set(), headers = [];
  for (let i = 0; i < ordered.length; i++) {
    const file = ordered[i], part = validatedPartNumber(file?.name, i + 1);
    if (!Number.isSafeInteger(file.size) || file.size < 100 ||
        file.size > MAX_VAULT_OFFLINE_ENVELOPE_BYTES ||
        typeof file.arrayBuffer !== 'function') fail();
    let envelope;
    try {
      const raw = await file.arrayBuffer();
      if (raw.byteLength !== file.size ||
          raw.byteLength > MAX_VAULT_OFFLINE_ENVELOPE_BYTES)
        fail();
      envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    } catch { fail(); }
    validateEnvelope(envelope, part);
    if (commonSalt === null) {
      commonSalt = envelope.salt;
      key = await deriveKey(passphrase, hexToBytes(commonSalt, 16),
        webCrypto.subtle);
    }
    if (envelope.salt !== commonSalt || knownIVs.has(envelope.iv))
      fail();
    knownIVs.add(envelope.iv);
    const ciphertext = decodeBytes(envelope.ciphertext);
    if (ciphertext.byteLength !== envelope.plainBytes + 16)
      fail();
    headers.push({ envelope, ciphertext });
  }
  return headers.map(({ envelope, ciphertext }) => ({
    name: partName(envelope.part) + '.json',
    size: envelope.plainBytes,
    async arrayBuffer() {
      try {
        const decrypted = await webCrypto.subtle.decrypt({
          name: 'AES-GCM', iv: hexToBytes(envelope.iv, 12),
          additionalData: encoder.encode(JSON.stringify(
            canonicalHeader(envelope))), tagLength: 128,
        }, key, ciphertext);
        if (decrypted.byteLength !== envelope.plainBytes) fail();
        return decrypted;
      } catch { fail(); }
    },
  }));
}
