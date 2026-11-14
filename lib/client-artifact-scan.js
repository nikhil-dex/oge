import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const PUBLIC_OUTPUT_EXTENSIONS = new Set(['.html', '.rsc', '.txt', '.json', '.body']);

/**
 * Inspect generated browser assets and prerendered response artifacts, not
 * server JS bundles (which legitimately contain private environment values).
 * Never echo secret contents to the terminal or CI logs.
 */
export async function scanClientArtifacts(outputRoot, canaries) {
  if (!Array.isArray(canaries) || !canaries.length ||
      canaries.some((value) => typeof value !== 'string' || value.length < 16)) {
    throw new TypeError('Expected nonempty array of synthetic canaries (16+ characters).');
  }
  const scanDirs = [
    { root: path.join(outputRoot, 'static'), all: true },
    { root: path.join(outputRoot, 'server', 'app'), all: false },
    { root: path.join(outputRoot, 'server', 'pages'), all: false },
  ];
  let filesScanned = 0;
  const failures = [];

  async function walk(directory, includeAll) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(file, includeAll);
      } else if (entry.isFile() &&
        (includeAll || PUBLIC_OUTPUT_EXTENSIONS.has(path.extname(entry.name)))) {
        filesScanned += 1;
        const bytes = await readFile(file);
        // Use binary-safe Buffer search; a secret could be embedded in a binary
        // source map or compressed-looking chunk without valid UTF-8 text.
        if (canaries.some((secret) => bytes.includes(Buffer.from(secret)))) {
          failures.push(path.relative(outputRoot, file));
        }
      }
    }
  }
  for (const directory of scanDirs) await walk(directory.root, directory.all);
  if (filesScanned === 0) throw new Error('No client artifacts found; refusing to mark scan successful.');
  return { filesScanned, failures };
}
