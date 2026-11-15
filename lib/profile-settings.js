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
  // No visually confusable unicode, slashes, punctuation or reserved routing.
  if (!/^[a-z][a-z0-9_]{2,23}$/.test(name)) return null;
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
