/**
 * Helpers for detecting and parsing X/Twitter post URLs.
 */
const X_POST_PATTERNS: RegExp[] = [
  /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/(?:i\/web\/status|[\w_\-]+\/status)\/(\d+)/i,
  /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/i\/status\/(\d+)/i,
];

/**
 * Extracts the numeric post ID from an X/Twitter URL.
 */
export function extractXPostId(url: string): string | null {
  if (!url) return null;
  for (const pattern of X_POST_PATTERNS) {
    const match = url.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }
  return null;
}

/**
 * Determines whether a URL belongs to X/Twitter based on typical post patterns.
 */
export function isXPostUrl(url: string): boolean {
  return !!extractXPostId(url);
}

