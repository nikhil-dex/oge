// M98: explicit, read-only public YouTube playlist discovery. No content persistence.
// API key must remain server-side. Fetches are pinned to Google's official endpoint.
const PLAYLIST_ID = /^[A-Za-z0-9_-]{10,120}$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const MAX_VIDEOS = 500;
const PAGE_SIZE = 50;
const MAX_PAGES = MAX_VIDEOS / PAGE_SIZE;
const TOKEN = /^[A-Za-z0-9_=\-]{1,256}$/;
const ENDPOINT = 'https://www.googleapis.com/youtube/v3/playlistItems';

export class PlaylistDiscoveryError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'PlaylistDiscoveryError';
    this.status = status;
  }
}

export async function discoverPublicPlaylist(playlistId, apiKey, fetchImpl = fetch) {
  if (!PLAYLIST_ID.test(playlistId)) throw new PlaylistDiscoveryError('Invalid playlist identifier.', 400);
  if (typeof apiKey !== 'string' || !/^[A-Za-z0-9_-]{20,160}$/.test(apiKey))
    throw new PlaylistDiscoveryError('YouTube discovery is not configured.', 503);
  const videos = [];
  const seenTokens = new Set();
  let nextPageToken = '';
  let expectedTotal = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(ENDPOINT);
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('fields', 'nextPageToken,pageInfo(totalResults),items(snippet(position,title,resourceId(videoId)))');
    url.searchParams.set('playlistId', playlistId);
    url.searchParams.set('maxResults', String(PAGE_SIZE));
    url.searchParams.set('key', apiKey);
    if (nextPageToken) url.searchParams.set('pageToken', nextPageToken);
    let response;
    try {
      response = await fetchImpl(url.toString(), {
        method: 'GET', cache: 'no-store', redirect: 'error',
        headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(9000),
      });
    } catch {
      throw new PlaylistDiscoveryError('YouTube did not respond. Retry later.');
    }
    if (!response?.ok) {
      const status = response?.status;
      if (status === 400 || status === 404)
        throw new PlaylistDiscoveryError('This public playlist could not be found.', 404);
      if (status === 403 || status === 429)
        throw new PlaylistDiscoveryError('YouTube denied this request or its API quota is exhausted.', 503);
      throw new PlaylistDiscoveryError('YouTube playlist lookup is unavailable.');
    }
    let data;
    try { data = await response.json(); }
    catch { throw new PlaylistDiscoveryError('YouTube returned an invalid response.'); }
    if (!data || !Array.isArray(data.items) || !Number.isSafeInteger(data.pageInfo?.totalResults) ||
        data.pageInfo.totalResults < 0 || data.pageInfo.totalResults > MAX_VIDEOS)
      throw new PlaylistDiscoveryError('Playlist metadata is invalid or exceeds the 500-video preview limit.', 422);
    if (expectedTotal === null) expectedTotal = data.pageInfo.totalResults;
    if (data.pageInfo.totalResults !== expectedTotal || videos.length + data.items.length > MAX_VIDEOS ||
        data.items.length > PAGE_SIZE || (data.items.length === 0 && data.nextPageToken))
      throw new PlaylistDiscoveryError('Playlist changed or has an incomplete page. Retry discovery.', 409);
    for (const item of data.items) {
      const snippet = item?.snippet;
      const videoId = snippet?.resourceId?.videoId;
      const title = typeof snippet?.title === 'string' ? snippet.title.replace(/\s+/g, ' ').trim() : '';
      if (!Number.isSafeInteger(snippet?.position) || snippet.position !== videos.length ||
          !VIDEO_ID.test(videoId || '') || !title || title.length > 300 ||
          /^(private video|deleted video)$/i.test(title))
        throw new PlaylistDiscoveryError('Playlist contains an unavailable video or its order changed.', 422);
      videos.push({
        position: snippet.position, videoId,
        title: title.slice(0, 180),
        url: 'https://www.youtube.com/watch?v=' + videoId + '&list=' + playlistId,
      });
    }
    if (!data.nextPageToken) {
      if (videos.length === 0 || videos.length !== expectedTotal)
        throw new PlaylistDiscoveryError('Playlist is empty or results are incomplete.', 422);
      return { videos, totalVideos: videos.length };
    }
    if (!TOKEN.test(data.nextPageToken) || seenTokens.has(data.nextPageToken))
      throw new PlaylistDiscoveryError('YouTube returned an invalid pagination cursor.');
    seenTokens.add(data.nextPageToken);
    nextPageToken = data.nextPageToken;
  }
  throw new PlaylistDiscoveryError('Playlist exceeds the 500-video preview limit.', 422);
}
