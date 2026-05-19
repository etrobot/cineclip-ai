import { Cookie } from 'tough-cookie';
import { Scraper } from '@the-convocation/twitter-scraper';

const {
  X_SCRAPER_USERNAME,
  X_SCRAPER_PASSWORD,
  X_SCRAPER_EMAIL,
  X_SCRAPER_COOKIES,
} = process.env;

let scraperInstance: Scraper | null = null;
let authPromise: Promise<void> | null = null;

function getScraper(): Scraper {
  if (!scraperInstance) {
    scraperInstance = new Scraper({
      fetch: globalThis.fetch,
    });
  }
  return scraperInstance;
}

function buildCookies(cookieString: string): Cookie[] {
  return cookieString
    .split(/;\s*/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => Cookie.parse(segment))
    .filter((cookie): cookie is Cookie => Boolean(cookie));
}

async function ensureScraperAuth(): Promise<void> {
  if (authPromise) {
    return authPromise;
  }

  authPromise = (async () => {
    const scraper = getScraper();

    if (X_SCRAPER_COOKIES) {
      const cookies = buildCookies(X_SCRAPER_COOKIES);
      if (cookies.length > 0) {
        await scraper.setCookies(cookies);
      }
    }

    if (X_SCRAPER_USERNAME && X_SCRAPER_PASSWORD) {
      await scraper.login(X_SCRAPER_USERNAME, X_SCRAPER_PASSWORD, X_SCRAPER_EMAIL);
    }
  })().catch((error) => {
    console.warn('[X Scraper] Authentication failed', error);
  });

  return authPromise;
}

async function fetchTweetFromScraper(postId: string): Promise<any | null> {
  const scraper = getScraper();
  const getter =
    (scraper as any).getTweetById?.bind(scraper) ||
    (scraper as any).getTweet?.bind(scraper) ||
    (scraper as any).tweet?.bind(scraper) ||
    (scraper as any).getStatus?.bind(scraper);

  if (!getter) {
    console.warn('[X Scraper] Tweet getter not found on scraper instance');
    return null;
  }

  try {
    const result = await getter(postId);
    return result || null;
  } catch (error) {
    console.warn(`[X Scraper] Failed to fetch tweet ${postId}`, error);
    return null;
  }
}

function pickText(tweet: any): string {
  return (
    tweet?.text ||
    tweet?.full_text ||
    tweet?.renderedText ||
    tweet?.body ||
    tweet?.displayText ||
    ''
  );
}

function pickAuthorName(tweet: any): string {
  return (
    tweet?.user?.name ||
    tweet?.author?.name ||
    tweet?.user?.username ||
    tweet?.author?.username ||
    tweet?.user?.screen_name ||
    tweet?.author?.screenName ||
    'Unknown'
  );
}

function pickPublishedAt(tweet: any): string | undefined {
  const candidate = tweet?.created_at || tweet?.createdAt || tweet?.timestamp;
  if (!candidate) return undefined;
  const parsed = Date.parse(candidate);
  if (Number.isNaN(parsed)) {
    return undefined;
  }
  return new Date(parsed).toISOString();
}

export interface TweetMetadata {
  authorName: string;
  authorUsername?: string;
  content: string;
  publishedAt?: string;
}

export async function fetchTweetMetadata(postId: string): Promise<TweetMetadata | null> {
  await ensureScraperAuth();
  const tweet = await fetchTweetFromScraper(postId);
  if (!tweet) {
    return null;
  }

  const content = pickText(tweet);
  const authorName = pickAuthorName(tweet);
  const authorUsername =
    tweet?.user?.screen_name || tweet?.author?.screenName || tweet?.author?.username;
  const publishedAt = pickPublishedAt(tweet);

  return {
    authorName,
    authorUsername,
    content,
    publishedAt,
  };
}
