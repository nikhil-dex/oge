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


// M98: schedule is calculated from a fresh public playlist snapshot, not persisted.
// A dated start is optional. Dates are ISO calendar days, avoiding local timezone drift.
export function buildDailyLessons(videos, videosPerDay, completedVideos, startDate = '') {
  if (!Array.isArray(videos) || videos.length > 500 || !Number.isInteger(videosPerDay) ||
      videosPerDay < 1 || videosPerDay > 20 || !Number.isInteger(completedVideos) ||
      completedVideos < 0 || completedVideos > videos.length)
    throw new TypeError('Invalid playlist schedule input.');
  let start = null;
  if (startDate) {
    if (typeof startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(startDate))
      throw new TypeError('Invalid schedule start date.');
    start = new Date(startDate + 'T00:00:00.000Z');
    if (!Number.isFinite(start.getTime()) || start.toISOString().slice(0, 10) !== startDate)
      throw new TypeError('Invalid schedule start date.');
  }
  const days = [];
  for (let from = 0; from < videos.length; from += videosPerDay) {
    const slice = videos.slice(from, from + videosPerDay);
    const date = start ? new Date(start.getTime() + days.length * 86400000).toISOString().slice(0, 10) : null;
    days.push({
      day: days.length + 1, date,
      videos: slice.map((video, index) => ({
        ...video, completed: from + index < completedVideos,
      })),
    });
  }
  return days;
}
