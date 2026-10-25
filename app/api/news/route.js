import { auth } from '../../../auth.js';
import { getDatabase } from '../../../lib/mongodb.js';

export const dynamic = 'force-dynamic';

const TOPICS = {
  'Technology': 'technology software hardware product launches',
  'Artificial Intelligence': 'artificial intelligence AI machine learning research',
  'Science': 'science research discoveries',
  'Business & Finance': 'business finance markets economy',
  'World News': 'international world news',
  'India News': 'India national news',
  'Politics': 'politics government elections policy',
  'Health': 'health medical research public health',
  'Education': 'education universities learning',
  'Startups': 'startups venture capital founders',
  'Gaming': 'video games gaming industry',
  'Anime & Entertainment': 'anime animation entertainment film television',
  'Sports': 'sports tournaments teams',
  'Environment': 'environment climate conservation',
  'Space & Astronomy': 'space astronomy NASA ISRO'
};
const DEFAULT_TOPICS = ['India News', 'Technology', 'Science', 'World News'];

function decodeXml(value = '') {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16))).trim();
}
function tagValue(xml, tag) {
  const match = xml.match(new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${tag}\\s*>`, 'i'));
  return match ? decodeXml(match[1]) : '';
}
function parseFeed(xml, category) {
  return [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((match) => {
    const item = match[1];
    const title = tagValue(item, 'title');
    const url = tagValue(item, 'link');
    const publishedAt = tagValue(item, 'pubDate');
    const source = tagValue(item, 'source');
    if (!title || !url || !/^https?:\/\//i.test(url)) return null;
    return { id: category + '-' + url, title, url, publishedAt, source: source || (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } })(), category };
  }).filter(Boolean);
}
export async function GET() {
  try {
    const session = await auth();
    const ownerId = session?.user?.id;
    if (!ownerId) return Response.json({ error: 'Sign in to view news.' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
    const db = await getDatabase();
    const account = await db.collection('users').findOne({ googleSub: ownerId }, { projection: { newsInterests: 1 } });
    const selected = Array.isArray(account?.newsInterests) ? account.newsInterests.filter((topic) => Object.hasOwn(TOPICS, topic)).slice(0, 6) : [];
    const topics = selected.length ? selected : DEFAULT_TOPICS;
    const results = await Promise.allSettled(topics.map(async (category) => {
      const query = encodeURIComponent((TOPICS[category] || TOPICS['World News']) + ' when:7d');
      const url = `https://news.google.com/rss/search?q=${query}&hl=en-IN&gl=IN&ceid=IN%3Aen`;
      const response = await fetch(url, { headers: { 'User-Agent': 'OgeNotes News Reader/1.0' }, next: { revalidate: 300 }, signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error('News feed returned ' + response.status);
      return parseFeed(await response.text(), category);
    }));
    const stories = results.flatMap((result) => result.status === 'fulfilled' ? result.value : []).sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0));
    const unique = [];
    const seen = new Set();
    for (const story of stories) {
      const key = story.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (seen.has(key)) continue;
      seen.add(key); unique.push(story);
    }
    if (!unique.length) return Response.json({ stories: [], error: 'News feeds are temporarily unavailable.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    return Response.json({ stories: unique.slice(0, 36), topics, personalized: selected.length > 0, fetchedAt: new Date().toISOString() }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('GET /api/news failed:', error?.name);
    return Response.json({ error: 'Could not load the news feed.' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
