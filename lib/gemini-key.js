import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

function encryptionKey() {
  const secret = process.env.GEMINI_KEY_ENCRYPTION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('GEMINI_KEY_ENCRYPTION_SECRET must be configured with at least 32 characters.');
  }
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function encryptGeminiKey(apiKey) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    updatedAt: new Date(),
  };
}

export function decryptGeminiKey(payload) {
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export function maskGeminiKey(apiKey) {
  return apiKey.length < 10 ? '••••••••' : apiKey.slice(0, 4) + '••••••••' + apiKey.slice(-4);
}
