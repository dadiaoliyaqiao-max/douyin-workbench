/** Shared, framework-free helpers for workspace-local cover images. */
export const MAX_COVER_BYTES = 5 * 1024 * 1024;
const SAFE_RELATIVE = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
const TYPES = [[/\.jpe?g$/i, 'image/jpeg'], [/\.png$/i, 'image/png'], [/\.webp$/i, 'image/webp']];

/** A cover reference must be a simple relative path inside the approved batch directory. */
export function coverFileOf(row) {
  const cover = row && typeof row === 'object' ? row.cover : undefined;
  const value = typeof cover?.file === 'string' ? cover.file : '';
  if (!value || value.length > 200 || !SAFE_RELATIVE.test(value)) return null;
  if (value.split('/').some(part => part === '.' || part === '..')) return null;
  return value;
}

export function coverTypeOf(file) {
  if (typeof file !== 'string') return null;
  return TYPES.find(([pattern]) => pattern.test(file))?.[1] ?? null;
}

/** Extract a cover path from a Markdown image link, tolerating angle brackets. */
export function markdownCoverPath(line) {
  const match = typeof line === 'string' ? line.match(/!\[[^\]]*\]\(<?([^)>]+)>?\)/) : null;
  return match ? coverFileOf({ cover: { file: match[1].trim() } }) : null;
}
