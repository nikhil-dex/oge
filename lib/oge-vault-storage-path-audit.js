import { readdir, readFile } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';

/**
 * Phase C cutover guard: reviewed legacy content pathways. An entry means
 * "existing production dependency that must be migrated or deliberately
 * gated before GitHub-only cutover", NOT an authorization to keep writing
 * permanent content to MongoDB after cutover.
 *
 * Keep this list explicit: any new unreviewed collection reference makes
 * the audit fail instead of silently becoming another storage backend.
 */
export const REVIEWED_LEGACY_CONTENT_SURFACES = Object.freeze({
  'app/api/notes/route.js': {
    collections: ['notes'], action: 'read-create-update-delete', cutoverBlocker: true,
  },
  'app/api/notes/cleanup/route.js': {
    collections: ['notes'], action: 'legacy-read-for-ai-suggestion', cutoverBlocker: true,
  },
  'app/api/backup/route.js': {
    collections: ['notes', 'quickNotes', 'personalQuickNotes'],
    action: 'export-and-import-content-with-revisions', cutoverBlocker: true,
  },
  'app/api/revision/route.js': {
    collections: ['notes'], action: 'read-and-write-review-progress', cutoverBlocker: true,
  },
  'app/api/revision-history/route.js': {
    collections: ['notes'], action: 'read-and-restore-full-note-content', cutoverBlocker: true,
  },
  'app/api/quick-notes/route.js': {
    collections: ['quickNotes'], action: 'read-create-update-delete', cutoverBlocker: true,
  },
  'app/api/personal-quick-notes/route.js': {
    collections: ['personalQuickNotes'], action: 'read-create-update-delete', cutoverBlocker: true,
  },
  'app/api/extension/quick-note/route.js': {
    collections: ['notes', 'quickNotes'], action: 'extension-create-content', cutoverBlocker: true,
  },
  'lib/atomic-subject-deletion.js': {
    collections: ['notes'], action: 'legacy-subject-cascade-delete', cutoverBlocker: true,
  },
  'lib/oge-vault-subject-finalization.js': {
    collections: ['notes'], action: 'legacy-content-absence-safety-check', cutoverBlocker: false,
  },
});

// These known helpers use a variable-based collection lookup, and are deliberately
// inspected separately. Dynamic access cannot be resolved by string scanning.
export const REVIEWED_DYNAMIC_COLLECTION_SURFACES = Object.freeze([
  'lib/account-deletion-transaction.js',
  'lib/oge-vault-legacy-inventory.js',
]);

const CONTENT_COLLECTIONS = new Set(['notes', 'quickNotes', 'personalQuickNotes']);
const roots = ['app', 'lib', 'extension', 'scripts'];
const directReference = /\.collection\(\s*(['"`])([a-zA-Z][a-zA-Z0-9]*)\1\s*\)/g;
const dynamicReference = /\.collection\(\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\)/g;

export async function collectVaultStoragePathSources(root) {
  const sources = Object.create(null);
  async function walk(directory) {
    for (const item of await readdir(join(root, directory), { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isDirectory()) await walk(path);
      else if (item.isFile() && ['.js', '.mjs', '.ts', '.tsx'].includes(extname(item.name)))
        sources[relative(root, join(root, path)).replaceAll('\\', '/')] =
          await readFile(join(root, path), 'utf8');
    }
  }
  for (const directory of roots) await walk(directory);
  return sources;
}

/**
 * Accepts only source strings, not data records. Reports filenames and
 * collection names: never report code excerpts, note content, credentials,
 * owner IDs or database URIs.
 */
export function auditVaultLegacyStoragePaths(sources) {
  if (!sources || typeof sources !== 'object')
    throw new TypeError('Source mapping required');
  const observed = Object.create(null);
  const unexpected = [];
  const missing = [];
  const dynamicUnknown = [];
  const dynamicReviewed = [];

  for (const [path, code] of Object.entries(sources)) {
    if (typeof code !== 'string' || !path || path.split('/').some((part) => part === '..' || part === '.'))
      throw new TypeError('Invalid source mapping');
    const names = new Set();
    for (const match of code.matchAll(directReference)) {
      if (CONTENT_COLLECTIONS.has(match[2])) names.add(match[2]);
    }
    if (names.size) {
      const declared = REVIEWED_LEGACY_CONTENT_SURFACES[path];
      const recorded = [...names].sort();
      observed[path] = recorded;
      if (!declared || JSON.stringify(recorded) !== JSON.stringify([...declared.collections].sort()))
        unexpected.push({ path, collections: recorded });
    }
    if (!REVIEWED_DYNAMIC_COLLECTION_SURFACES.includes(path)) {
      for (const match of code.matchAll(dynamicReference))
        dynamicUnknown.push({ path, variable: match[1] });
    } else if (code.match(dynamicReference)) {
      dynamicReviewed.push(path);
    }
  }

  for (const [path, declared] of Object.entries(REVIEWED_LEGACY_CONTENT_SURFACES)) {
    if (!Object.hasOwn(sources, path) ||
        JSON.stringify(observed[path] || []) !==
        JSON.stringify([...declared.collections].sort()))
      missing.push(path);
  }
  for (const path of REVIEWED_DYNAMIC_COLLECTION_SURFACES) {
    if (!Object.hasOwn(sources, path) ||
        !dynamicReviewed.includes(path))
      missing.push(path);
  }

  const hasDirectBlockers = Object.values(REVIEWED_LEGACY_CONTENT_SURFACES)
    .some((surface) => surface.cutoverBlocker);
  return {
    ok: unexpected.length === 0 && missing.length === 0 &&
      dynamicUnknown.length === 0,
    reviewedLegacyPaths: Object.keys(observed).sort(),
    reviewedDynamicPaths: dynamicReviewed.sort(),
    unexpected, missing, dynamicUnknown,
    // A green static audit only says all currently known paths are reviewed.
    // It NEVER means those paths have been migrated.
    cutoverAuthorized: false,
    cutoverBlockedByLegacyPaths: hasDirectBlockers,
    fullContentAuditCompleted: false,
    staticPatternsOnly: true,
  };
}
