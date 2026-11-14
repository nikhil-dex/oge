// User-exportable note history and review scheduling metadata.
// Never export ownerId, auth fields, provider credentials or raw MongoDB IDs.
const RATINGS = new Set(['again', 'hard', 'good', 'easy']);
const MAX_REVISIONS = 20;

function timestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  if (!(typeof value === 'string' || value instanceof Date)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function exportNoteMetadata(note) {
  const revisions = Array.isArray(note?.revisions) ? note.revisions : [];
  return {
    revisions: revisions.slice(-MAX_REVISIONS).filter((item) =>
      item && typeof item.heading === 'string' && typeof item.answer === 'string'
    ).map((item) => ({
      heading: item.heading.slice(0, 160),
      answer: item.answer.slice(0, 20000),
      savedAt: timestamp(item.savedAt),
    })),
    reviewCount: Number.isSafeInteger(note?.reviewCount) && note.reviewCount >= 0 ? note.reviewCount : 0,
    lastReviewRating: RATINGS.has(note?.lastReviewRating) ? note.lastReviewRating : null,
    lastReviewedAt: timestamp(note?.lastReviewedAt),
    reviewDueAt: timestamp(note?.reviewDueAt),
  };
}

export function importNoteMetadata(source) {
  const revisions = source?.revisions === undefined ? [] : source.revisions;
  if (!Array.isArray(revisions) || revisions.length > MAX_REVISIONS) return null;
  const sanitized = [];
  for (const revision of revisions) {
    if (!revision || typeof revision.heading !== 'string' || revision.heading.length > 160 ||
        typeof revision.answer !== 'string' || revision.answer.length > 20000) return null;
    const savedAt = timestamp(revision.savedAt);
    if (revision.savedAt != null && !savedAt) return null;
    sanitized.push({ heading: revision.heading, answer: revision.answer, ...(savedAt ? { savedAt: new Date(savedAt) } : {}) });
  }
  const reviewCount = source?.reviewCount ?? 0;
  if (!Number.isSafeInteger(reviewCount) || reviewCount < 0 || reviewCount > 1_000_000) return null;
  const lastReviewRating = source?.lastReviewRating ?? null;
  if (lastReviewRating !== null && !RATINGS.has(lastReviewRating)) return null;
  const lastReviewedAt = timestamp(source?.lastReviewedAt);
  const reviewDueAt = timestamp(source?.reviewDueAt);
  if ((source?.lastReviewedAt != null && !lastReviewedAt) ||
      (source?.reviewDueAt != null && !reviewDueAt)) return null;
  return {
    revisions: sanitized,
    reviewCount,
    ...(lastReviewRating ? { lastReviewRating } : {}),
    ...(lastReviewedAt ? { lastReviewedAt: new Date(lastReviewedAt) } : {}),
    ...(reviewDueAt ? { reviewDueAt: new Date(reviewDueAt) } : {}),
  };
}
