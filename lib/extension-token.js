import { createHash, randomBytes } from 'node:crypto';

export function createExtensionToken() {
  return 'oge_' + randomBytes(32).toString('base64url');
}
export function hashExtensionToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}
