// Learning Tracks M97: playlist metadata only. No video scraping or note bodies.
const PLAYLIST_ID = /^[A-Za-z0-9_-]{10,120}$/;
const VIDEO_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be']);

export function parseYouTubePlaylist(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  let url;
  try { url = new URL(raw.trim()); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password ||
      !VIDEO_HOSTS.has(url.hostname.toLowerCase())) return null;
  const short = url.hostname.toLowerCase().endsWith('youtu.be');
  if (!short && !['/playlist', '/watch'].includes(url.pathname)) return null;
  if (short && !/^\/[A-Za-z0-9_-]{11}$/.test(url.pathname)) return null;
  const list = url.searchParams.getAll('list');
  if (list.length !== 1 || !PLAYLIST_ID.test(list[0])) return null;
  return { playlistId: list[0], playlistUrl: 'https://www.youtube.com/playlist?list=' + list[0] };
}

export function normalizeLearningTrack(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'Enter a valid learning track.' };
  const playlist = parseYouTubePlaylist(value.url);
  if (!playlist) return { error: 'Paste an HTTPS YouTube playlist or playlist watch link.' };
  const title = typeof value.title === 'string' ? value.title.replace(/\s+/g, ' ').trim() : '';
  if (!title || title.length > 120) return { error: 'Enter a title of up to 120 characters.' };
  const videosPerDay = value.videosPerDay;
  if (!Number.isInteger(videosPerDay) || videosPerDay < 1 || videosPerDay > 20)
    return { error: 'Videos per day must be between 1 and 20.' };
  const totalVideos = value.totalVideos === null || value.totalVideos === undefined ? null : value.totalVideos;
  if (totalVideos !== null && (!Number.isInteger(totalVideos) || totalVideos < 1 || totalVideos > 10000))
    return { error: 'Total videos must be between 1 and 10,000, or left unknown.' };
  return { value: { ...playlist, title, videosPerDay, totalVideos } };
}

export function publicLearningTrack(track) {
  return {
    id: String(track._id), playlistId: track.playlistId, url: track.playlistUrl,
    title: track.title, videosPerDay: track.videosPerDay,
    totalVideos: track.totalVideos ?? null, completedVideos: track.completedVideos,
    createdAt: track.createdAt, updatedAt: track.updatedAt,
  };
}
