/**
 * M66 restricted encrypted offline Notes -> in-memory restore adapter.
 * Local decryption/integrity is NOT signed GitHub source authentication.
 */
import { createReadStream, constants, fstatSync } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';
import {
  MAX_VAULT_OFFLINE_ENVELOPE_BYTES,
  openVaultOfflineEncryptedFiles,
} from './oge-vault-offline-backup-crypto.js';
import { verifyVaultRestoreLocalChunkFiles } from './oge-vault-restore-local-chunks.js';

const LIMIT = 16;
const MAX_SECRET_BYTES = 1024;
const fail = () => {
  throw new TypeError('Unsafe or invalid private encrypted restore input');
};
const privateOwner = (stat) =>
  (stat.mode & 0o077) === 0 &&
  (typeof process.getuid !== 'function' || stat.uid === process.getuid());

function validFile(stat) {
  return stat.isFile() && privateOwner(stat) &&
    stat.size >= 100 && stat.size <= MAX_VAULT_OFFLINE_ENVELOPE_BYTES;
}

/**
 * Read only a dedicated FIFO/pipe or private socketpair at FD3. Never accept secrets from argv,
 * env, reusable password file or visible terminal. Parent closes pipe at EOF.
 */
export async function readVaultOperatorBackupPassphraseFd3() {
  try {
    const input = fstatSync(3);
    // Node's own child-process 'pipe' uses a private socketpair on Unix.
    if (!input.isFIFO() && !input.isSocket()) fail();
    const chunks = [];
    let total = 0;
    try {
      const stream = createReadStream('', {
        fd: 3, autoClose: true, highWaterMark: MAX_SECRET_BYTES + 1,
      });
      for await (const chunk of stream) {
        total += chunk.length;
        if (total > MAX_SECRET_BYTES) {
          chunk.fill(0);
          fail();
        }
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks, total);
      try {
        const passphrase = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (passphrase.length < 16 || passphrase.length > 256 ||
            passphrase.includes('\0') || !passphrase.trim() ||
            passphrase.includes('\n') || passphrase.includes('\r')) fail();
        return passphrase;
      } finally { bytes.fill(0); }
    } finally {
      for (const chunk of chunks) chunk.fill(0);
    }
  } catch { fail(); }
}

async function readPrivateEncryptedParts(folder) {
  const directory = await lstat(folder);
  if (!directory.isDirectory() || !privateOwner(directory)) fail();
  const names = await readdir(folder);
  if (names.length < 1 || names.length > LIMIT) fail();
  names.sort();
  const files = [];
  for (let i = 0; i < names.length; i++) {
    const expected = 'part-' + String(i + 1).padStart(4, '0') + '.oge.json';
    if (names[i] !== expected) fail();
    let handle;
    try {
      handle = await open(join(folder, expected),
        constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch { fail(); }
    try {
      const before = await handle.stat();
      if (!validFile(before)) fail();
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (!validFile(after) || before.ino !== after.ino ||
          before.dev !== after.dev || before.size !== bytes.length ||
          after.size !== bytes.length || before.mtimeMs !== after.mtimeMs)
        fail();
      // The buffered bytes remain ciphertext; never write plaintext files.
      files.push({
        name: expected, size: bytes.length,
        async arrayBuffer() {
          return bytes.buffer.slice(bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength);
        },
      });
    } finally { await handle.close(); }
  }
  return files;
}

/**
 * Verify the entire decrypted source and the exact reviewed M57 fingerprint
 * before any MongoDB access or one-use restore receipt claim. After this,
 * M58 STILL independently authenticates signed private GitHub source blobs.
 */
export async function prepareVaultOperatorEncryptedRestore(
  folder, passphrase, approved,
) {
  const files = await readPrivateEncryptedParts(folder);
  const decrypted = await openVaultOfflineEncryptedFiles(files, passphrase, {
    webCrypto: webcrypto,
  });
  const review = {
    sourceSnapshot: approved?.expectedSourceSnapshot,
    inventoryDigest: approved?.expectedSourceInventorySha256,
    targetHead: approved?.expectedTargetHead,
    fingerprint: approved?.expectedSelectionFingerprint,
    selectedIdsText: Array.isArray(approved?.selectedIds)
      ? approved.selectedIds.join('\n') : '',
  };
  const verified = await verifyVaultRestoreLocalChunkFiles(decrypted, review, {
    subtle: webcrypto.subtle,
  });
  if (verified.completeLocalSequenceVerified !== true ||
      verified.reviewedSelectionFingerprintMatches !== true ||
      verified.requiresIndependentSignedOperatorProof !== true ||
      verified.canWriteGitHub !== false) fail();

  return {
    preflightComplete: true, encryptedParts: files.length,
    signedGitHubSourceAuthenticated: false,
    async *chunks() {
      for (const file of decrypted) {
        const plain = await file.arrayBuffer();
        try {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(plain);
          yield JSON.parse(text);
        } finally { new Uint8Array(plain).fill(0); }
      }
    },
  };
}
