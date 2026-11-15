import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const PARAMS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const DUMMY_SALT = Buffer.alloc(16, 0x42);
const DUMMY_HASH = Buffer.alloc(64, 0x99);

export function normalizeLoginEmail(email) {
  if (typeof email !== 'string') return null;
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return null;
  return normalized;
}

export function validAccountPassword(value) {
  return typeof value === 'string' && value.length >= 12 && value.length <= 128 &&
    Buffer.byteLength(value, 'utf8') <= 512;
}

export async function hashAccountPassword(password) {
  if (!validAccountPassword(password)) throw new TypeError('Invalid password length');
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64, PARAMS);
  return 'scrypt-v1$' + salt.toString('base64url') + '$' + key.toString('base64url');
}

export async function verifyAccountPassword(password, storedHash) {
  const validInput = typeof password === 'string' && password.length <= 128 &&
    Buffer.byteLength(password, 'utf8') <= 512;
  const parts = typeof storedHash === 'string' ? storedHash.split('$') : [];
  const format = parts.length === 3 && parts[0] === 'scrypt-v1' &&
    /^[A-Za-z0-9_-]{22}$/.test(parts[1] || '') &&
    /^[A-Za-z0-9_-]{86}$/.test(parts[2] || '');
  const salt = format ? Buffer.from(parts[1], 'base64url') : DUMMY_SALT;
  const expected = format ? Buffer.from(parts[2], 'base64url') : DUMMY_HASH;
  // Always run the memory-hard KDF, including on unknown users, to reduce
  // timing differences that could reveal whether an email is registered.
  const actual = await scrypt(validInput ? password : '', salt, 64, PARAMS);
  return validInput && format && expected.length === 64 && timingSafeEqual(actual, expected);
}

export function isRecentGoogleAuthentication(session, now = Date.now()) {
  const at = session?.user?.authenticatedAt;
  return Number.isSafeInteger(at) && at <= now && now - at <= 10 * 60 * 1000;
}
