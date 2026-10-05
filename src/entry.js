import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * True when the module at `metaUrl` is the process entry (node <file> / npm run),
 * false when it is imported. Compared by native realpath, so a symlink or a
 * different path casing (macOS) still counts as the entry.
 * Usage: if (isEntryPoint(import.meta.url)) main();
 */
export function isEntryPoint(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return realpathSync.native(argv1) === realpathSync.native(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}
