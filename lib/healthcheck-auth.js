import { createHash, timingSafeEqual } from 'node:crypto';

// An uptime monitor must provide a distinct high-entropy server-side token.
// Never accept the credential in a query string, URL or cookie.
const MIN_TOKEN_LENGTH = 32;
const MAX_TOKEN_LENGTH = 256;

export function isHealthCheckAuthorized(header, configuredToken) {
  if (typeof configuredToken !== 'string' ||
      configuredToken.length < MIN_TOKEN_LENGTH ||
      configuredToken.length > MAX_TOKEN_LENGTH ||
      typeof header !== 'string') return false;
  const match = /^Bearer ([\x21-\x7e]+)$/.exec(header);
  if (!match || match[1].length < MIN_TOKEN_LENGTH ||
      match[1].length > MAX_TOKEN_LENGTH) return false;
  const received = createHash('sha256').update(match[1]).digest();
  const expected = createHash('sha256').update(configuredToken).digest();
  return timingSafeEqual(received, expected);
}
