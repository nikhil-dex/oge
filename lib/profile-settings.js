export const PROFILE_AVATARS = Object.freeze([
  { id: 'forest', label: 'Forest fox', emoji: '🦊', tone: 'forest' },
  { id: 'night', label: 'Night owl', emoji: '🦉', tone: 'night' },
  { id: 'ocean', label: 'Ocean whale', emoji: '🐳', tone: 'ocean' },
  { id: 'sunrise', label: 'Sunrise cat', emoji: '🐱', tone: 'sunrise' },
  { id: 'violet', label: 'Violet butterfly', emoji: '🦋', tone: 'violet' },
  { id: 'mint', label: 'Mint frog', emoji: '🐸', tone: 'mint' },
  { id: 'ember', label: 'Ember dragon', emoji: '🐉', tone: 'ember' },
  { id: 'sky', label: 'Sky astronaut', emoji: '👩‍🚀', tone: 'sky' },
]);

export function normalizeUsername(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().toLowerCase();
  // Normalize to a canonical, case-insensitive identifier. Allow internal
  // hyphens and underscores, but not leading/trailing separators, whitespace,
  // URLs or non-ASCII confusables. The unique DB index guards races.
  if (!/^[a-z][a-z0-9_-]{1,22}[a-z0-9]$/.test(name)) return null;
  return name;
}

export function normalizeProfileDisplayName(value) {
  if (typeof value !== 'string') return null;
  if (/[\u0000-\u001f\u007f<>]/.test(value)) return null;
  const name = value.trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 60) return null;
  return name;
}

export function isAllowedAvatar(value) {
  return value === 'google' || PROFILE_AVATARS.some((avatar) => avatar.id === value);
}


/**
 * Optional outbound profile links. Store canonical HTTPS URLs only; never
 * fetch user-submitted links from the server or interpret them as images.
 * Empty values are deliberately represented as null for easy removal.
 */
export function normalizeSocialLink(kind, value) {
  if (!['github', 'linkedin', 'portfolio'].includes(kind) || typeof value !== 'string') return undefined;
  const raw = value.trim();
  if (!raw) return null;
  if (raw.length > 2048 || /[\u0000-\u0020\u007f]/.test(raw)) return undefined;
  let url;
  try { url = new URL(raw); } catch { return undefined; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      url.hash || url.hostname.endsWith('.') || !url.hostname.includes('.')) return undefined;

  const hostname = url.hostname.toLowerCase();
  if (kind === 'github') {
    if (hostname !== 'github.com' || url.search) return undefined;
    const match = /^\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/?$/.exec(url.pathname);
    return match ? 'https://github.com/' + match[1] : undefined;
  }
  if (kind === 'linkedin') {
    if (!['linkedin.com', 'www.linkedin.com'].includes(hostname) || url.search) return undefined;
    const match = /^\/in\/([A-Za-z0-9][A-Za-z0-9_-]{1,99})\/?$/.exec(url.pathname);
    return match ? 'https://www.linkedin.com/in/' + match[1] : undefined;
  }

  // Portfolio links can include paths and queries, but not private/internal
  // names, numeric IP addresses, or non-HTTPS URLs.
  if (hostname === 'localhost' || hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') || hostname.endsWith('.internal') ||
      hostname.endsWith('.test') || hostname.endsWith('.example') ||
      /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname) ||
      hostname.startsWith('[') || hostname.includes(':') ||
      !/^[a-z0-9.-]+$/.test(hostname)) return undefined;
  return url.toString();
}
