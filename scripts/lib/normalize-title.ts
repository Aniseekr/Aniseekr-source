/**
 * Collapse a title to a comparison key: NFKC (full/half width), lowercase,
 * brackets + common punctuation + whitespace stripped.
 *
 * Ported verbatim from aniseekr `libs/services/pilgrimage/bangumi-title-match.ts`
 * (normalizeTitleKey) — the app's runtime matcher and this build-time matcher
 * must agree on what "the same title" means.
 */
export function normalizeTitleKey(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[『』「」《》【】()[\]（）]/g, '')
    .replace(/[!！?？:：,，.。'’"“”・\-_–—\s　]+/g, '')
    .trim();
}
