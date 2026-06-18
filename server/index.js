const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 5174;

app.use(cors());

// Track ongoing requests to prevent duplicates
const ongoingRequests = new Map();

// Tweets per page, ramping up: a tiny first page paints fast, then larger
// batches fill in on scroll. Pages past the schedule reuse the last size.
const PAGE_SCHEDULE = [15, 40, 100];
const sizeForPage = (page) => PAGE_SCHEDULE[Math.min(page, PAGE_SCHEDULE.length - 1)];
function pageRange(page) {
  let start = 0;
  for (let i = 0; i < page; i++) start += sizeForPage(i);
  return { start, end: start + sizeForPage(page) };
}

// Cache of deduped, newest-first captures per username so paging through a
// timeline doesn't re-hit the CDX API on every page. The slow part (snapshot
// fetches) still runs per page; this just avoids re-discovering the tweet list.
const CAPTURE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const captureCache = new Map(); // username -> { captures: [...], expires: number }

// Cache of fully parsed tweets keyed by snapshot URL. Archived tweets never
// change, so once we've fetched + scraped a snapshot we can serve it from
// memory forever (within TTL) — making re-scrolls and repeat searches instant
// and, crucially, sending zero extra requests to the Wayback Machine.
const TWEET_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const TWEET_CACHE_MAX = 5000; // simple cap to bound memory
const tweetCache = new Map(); // snapshotUrl -> { tweet: object|null, expires: number }

// Simple concurrency limiter: caps simultaneous outbound requests to Wayback
class ConcurrencyLimiter {
  constructor(limit) {
    this.limit = limit;
    this.running = 0;
    this.queue = [];
  }

  async run(fn) {
    if (this.running >= this.limit) {
      // Wait for a slot to become available
      await new Promise(resolve => this.queue.push(resolve));
    }
    
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      if (this.queue.length > 0) {
        this.queue.shift()();
      }
    }
  }
}

const limit = new ConcurrencyLimiter(3);

// Helper: strip surrounding quotes from text (e.g. from og:description)
function stripSurroundingQuotes(text) {
  const trimmed = (text || '').trim();
  const quotePairs = [
    ['"', '"'], ["'", "'"], ['\u201C', '\u201D'], ['\u2018', '\u2019'],
  ];
  for (const [open, close] of quotePairs) {
    if (trimmed.length >= 2 && trimmed.startsWith(open) && trimmed.endsWith(close)) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

// Helper: convert Wayback timestamp (YYYYMMDDHHMMSS) to ISO string
function parseWaybackTimestamp(waybackTs) {
  if (!waybackTs || waybackTs.length !== 14) return null;
  const year = waybackTs.substring(0, 4);
  const month = waybackTs.substring(4, 6);
  const day = waybackTs.substring(6, 8);
  const hour = waybackTs.substring(8, 10);
  const minute = waybackTs.substring(10, 12);
  const second = waybackTs.substring(12, 14);
  return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
}

// Helper: fetch a single CDX URL. Rejects on empty/garbage payloads so that a
// fast-but-empty response can't "win" the Promise.any race below over a slower
// response that actually has captures.
async function fetchCDXUrl(cdxUrl, signal) {
  const { data } = await axios.get(cdxUrl, {
    timeout: 15000, // ceiling, not a floor: the winner usually returns in ~2s
    signal,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WaybackBot/1.0)' },
  });
  if (!Array.isArray(data) || data.length <= 1) {
    throw new Error('empty CDX result');
  }
  return data;
}

// Race a group of CDX URLs: the first VALID response wins and the slower
// siblings are aborted immediately, so a single slow/stalled variant can't gate
// the whole load. Only fires a couple of requests to the lightweight index
// endpoint, and cancels the loser — so this stays well clear of the snapshot
// concurrency that has previously gotten us rate-limited.
async function raceCDXUrls(cdxUrls) {
  const controllers = cdxUrls.map(() => new AbortController());
  const requests = cdxUrls.map((url, i) => fetchCDXUrl(url, controllers[i].signal));
  try {
    return await Promise.any(requests);
  } finally {
    // Cancel any still-in-flight siblings (no-op once they've settled). Promise.any
    // already attaches reject handlers to every input, so the aborted losers won't
    // surface as unhandled rejections.
    controllers.forEach(c => c.abort());
  }
}

// Promise.any throws an AggregateError bundling every variant's failure; flatten
// it to a readable one-liner for logs.
function cdxErrorSummary(err) {
  if (err && Array.isArray(err.errors)) {
    return err.errors.map(e => e.message).join('; ');
  }
  return err.message;
}

// Helper: fetch CDX data with retries.
//
// NOTE: we deliberately do NOT use `collapse=urlkey` here. It makes Wayback
// group/scan the whole result set server-side, which routinely exceeds our
// timeout. Deduplication is instead done in `dedupeCaptures`.
//
// The plain query is the fast, complete one (~2s) and the `fl=original,timestamp`
// variant is actually SLOWER server-side despite a smaller payload, so instead
// of trusting one order we race them and take whichever responds first. The
// `limit=` variants are a last-resort fallback only: `limit` returns OLDEST-first
// up to the cap, so they can truncate prolific accounts and must not win normally.
async function fetchCDXData(username, retries = 2) {
  const base = `https://web.archive.org/cdx/search/cdx?url=twitter.com/${username}/status/*&output=json&filter=statuscode:200`;
  const primary = [base, `${base}&fl=original,timestamp`];
  const fallback = [`${base}&limit=1000`, `${base}&limit=500`];

  for (let attempt = 0; attempt < retries; attempt++) {
    for (const group of [primary, fallback]) {
      try {
        const data = await raceCDXUrls(group);
        console.log(`Successfully fetched ${data.length - 1} captures from CDX API`);
        return data;
      } catch (err) {
        console.log(`CDX attempt ${attempt + 1} round failed: ${cdxErrorSummary(err)}`);
      }
    }
    // Back off before the next full retry (skip after the last attempt).
    if (attempt < retries - 1) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  throw new Error('All CDX API attempts failed');
}

// Helper: collapse multiple archived captures of the same tweet down to a
// single capture, keeping the newest snapshot. Wayback re-crawls the same tweet
// many times, so without this we waste fetches re-scraping identical tweets and
// can surface duplicates in the UI. `collapse=urlkey` already does this
// server-side, but this is a guaranteed safety net if that param misbehaves or
// a fallback URL without collapse is used. Returns captures sorted oldest ->
// newest so a trailing slice() keeps the most recent unique tweets.
function dedupeCaptures(captures) {
  const byTweet = new Map();
  for (const cap of captures) {
    const match = cap.url.match(/\/status\/(\d+)/);
    const id = match ? match[1] : cap.url;
    const existing = byTweet.get(id);
    if (!existing || cap.timestamp > existing.timestamp) {
      byTweet.set(id, cap);
    }
  }
  // Wayback timestamps are zero-padded YYYYMMDDhhmmss strings, so lexical
  // comparison is equivalent to chronological order.
  return [...byTweet.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

// Returns the full, deduped, NEWEST-FIRST list of captures for a username,
// fetching from the CDX API only when not cached. This is the source of truth
// for pagination: page N is a slice of this list.
async function getOrderedCaptures(username) {
  const cached = captureCache.get(username);
  if (cached && cached.expires > Date.now()) {
    return cached.captures;
  }

  const data = await fetchCDXData(username);
  const headers = data[0];
  const urlIdx = headers.indexOf('original');
  const tsIdx = headers.indexOf('timestamp');

  const captures = data.slice(1)
    .filter(row => row[urlIdx] && row[urlIdx].includes('/status/'))
    .map(row => ({ url: row[urlIdx], timestamp: row[tsIdx] }));

  console.log(`Found ${captures.length} captures for @${username}`);

  // dedupeCaptures returns oldest->newest; reverse so page 0 is the newest tweets.
  const ordered = dedupeCaptures(captures).reverse();
  console.log(`Deduped to ${ordered.length} unique tweets for @${username}`);

  captureCache.set(username, { captures: ordered, expires: Date.now() + CAPTURE_CACHE_TTL_MS });
  return ordered;
}

// Helper: build a Wayback URL that serves the raw archived image bytes.
// The `im_` modifier returns the original file (no toolbar), and Wayback
// redirects to the nearest capture, so it works even when the live
// pbs.twimg.com asset is gone (suspended/deleted accounts).
function archiveImageUrl(originalUrl, waybackTimestamp) {
  if (!originalUrl) return '';
  const https = originalUrl.replace(/^http:/, 'https:');
  return `https://web.archive.org/web/${waybackTimestamp}im_/${https}`;
}

// Helper: upgrade a Twitter profile image to a larger variant for crisp avatars
function upgradeAvatarSize(url) {
  return (url || '').replace(/_(normal|bigger|mini|reasonably_small)\./, '_400x400.');
}

// A connection refusal/reset OR an explicit rate-limit status (429/503) from
// Wayback means we're being throttled or IP-blocked; callers use this to stop
// hammering a wall (and to avoid caching the failure as a "no tweet").
function isBlockError(err) {
  const code = err && (err.code || (err.cause && err.cause.code));
  const status = err && err.response && err.response.status;
  return code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EAI_AGAIN'
    || status === 429 || status === 503;
}

// Helper: fetch and extract tweet content + author identity from a Wayback snapshot
async function extractTweetFromSnapshot(snapshotUrl, waybackTimestamp) {
  const empty = {
    isReply: false,
    replyingTo: '',
    displayName: '',
    avatarUrl: '',
    media: [],
  };
  try {
    // Jitter so the few concurrent workers don't hit Wayback in lockstep bursts.
    await new Promise(r => setTimeout(r, 50 + Math.random() * 150));
    const { data, headers } = await axios.get(snapshotUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 7000, // 7 second timeout per request
    });
    
    // Try JSON first
    if (headers['content-type'] && headers['content-type'].includes('application/json')) {
      const json = typeof data === 'string' ? JSON.parse(data) : data;
      if (json && json.data && json.data.text && json.data.created_at) {
        return {
          ...empty,
          text: stripSurroundingQuotes(json.data.text),
          timestamp: json.data.created_at,
        };
      }
    }
    
    // Fallback: HTML parsing
    const $ = cheerio.load(data);

    // The main tweet on a permalink page (scope reply/avatar lookups to it so
    // we don't pick up conversation replies further down the page).
    const permalinkTweet = $('.permalink-tweet, .tweet.permalink-tweet, [data-permalink-path]').first();
    
    // --- tweet text ---
    let text = $('meta[property="og:description"]').attr('content') || '';
    if (!text) {
      text = $('div[data-testid="tweetText"]').text();
    }
    if (!text) {
      // Additional selectors for different Twitter layouts
      text = $('.tweet-text').text() || $('.js-tweet-text').text() || $('[data-testid="tweetText"]').text();
    }
    // Strip wrapping quotes now so downstream checks (e.g. leading @mention
    // reply detection) see the real first character, not a curly quote.
    text = stripSurroundingQuotes(text);
    
    // Try to find timestamp from tweet content first
    let timestamp = $('meta[property="article:published_time"]').attr('content') || '';
    if (!timestamp) {
      timestamp = $('time').attr('datetime') || '';
    }
    if (!timestamp) {
      // Additional timestamp selectors
      timestamp = $('.tweet-timestamp').attr('title') || $('.js-tweet-timestamp').attr('title') || '';
    }
    
    // If no tweet timestamp found, use Wayback timestamp as fallback
    if (!timestamp && waybackTimestamp) {
      timestamp = parseWaybackTimestamp(waybackTimestamp);
    }

    // --- reply detection ---
    let isReply = false;
    let replyingTo = '';
    // 1) DOM signals (classic server-rendered layout), when present
    const inReplyId =
      permalinkTweet.attr('data-in-reply-to-status-id') ||
      permalinkTweet.attr('data-in-reply-to-status-id-str') || '';
    const replyCtx = permalinkTweet.find('.ReplyingToContextBelowAuthor').first().text().trim();
    if (inReplyId) isReply = true;
    if (/replying to/i.test(replyCtx)) {
      isReply = true;
      replyingTo = replyCtx.replace(/replying to/i, '').replace(/\s+/g, ' ').trim();
    }
    // 2) Text heuristic: classic replies begin with one or more @mentions
    //    (e.g. "@madwheelclair Science obviously..."). This is the most reliable
    //    signal we have, since og:description rarely includes reply markup.
    const leadingMentions = (text.match(/^(?:@\w{1,15}\s+)+/) || [''])[0].trim();
    if (leadingMentions) {
      isReply = true;
      if (!replyingTo) replyingTo = leadingMentions;
    }

    // --- author display name ---
    let displayName = '';
    const ogTitle = $('meta[property="og:title"]').attr('content') || '';
    const ogMatch = ogTitle.match(/^(.*?)\s+on (?:Twitter|X)\b/i);
    if (ogMatch) displayName = ogMatch[1].trim();
    if (!displayName) {
      // classic title format: "Twitter / Jack Dorsey: ..."
      const classicMatch = ($('title').first().text() || '').match(/^Twitter\s*\/\s*([^:]+)/i);
      if (classicMatch) displayName = classicMatch[1].trim();
    }

    // --- author avatar ---
    let avatarOriginal =
      permalinkTweet.find('img.avatar, img.js-action-profile-avatar, .ProfileAvatar-image').first().attr('src') ||
      $('.permalink-tweet img.avatar').first().attr('src') ||
      $('.profile-pic img').first().attr('src') || '';
    if (!avatarOriginal) {
      // On a text-only tweet, og:image is the author's profile picture.
      const ogImg = $('meta[property="og:image"]').attr('content') || '';
      if (ogImg.includes('profile_images')) avatarOriginal = ogImg;
    }
    const avatarUrl = avatarOriginal
      ? archiveImageUrl(upgradeAvatarSize(avatarOriginal), waybackTimestamp)
      : '';

    // --- in-tweet media (photos) ---
    const media = [];
    permalinkTweet
      .find('.AdaptiveMedia-photoContainer img, .js-adaptive-photo img, .media-thumbnail img')
      .each((i, el) => {
        const src = $(el).attr('src') || $(el).attr('data-image-url') || '';
        if (src && /twimg\.com\/media/.test(src)) {
          media.push(archiveImageUrl(src, waybackTimestamp));
        }
      });
    
    if (text && timestamp) {
      return {
        text,
        timestamp,
        isReply,
        replyingTo,
        displayName,
        avatarUrl,
        media,
      };
    }
  } catch (err) {
    if (isBlockError(err)) throw err; // surface so the page can bail early
    // Skip failed requests silently
    console.log(`Failed to fetch ${snapshotUrl}: ${err.message}`);
  }
  return null;
}

// Cached wrapper around extractTweetFromSnapshot. The first request for a given
// snapshot hits Wayback; every later request is served from memory. We cache
// nulls too (briefly via the same TTL) so known-bad snapshots aren't refetched
// on every page load.
async function getTweet(snapshotUrl, waybackTimestamp) {
  const cached = tweetCache.get(snapshotUrl);
  if (cached && cached.expires > Date.now()) {
    return cached.tweet;
  }

  const tweet = await extractTweetFromSnapshot(snapshotUrl, waybackTimestamp);

  // Naive size bound: once full, drop the oldest entry (Map preserves insertion
  // order) before inserting the new one.
  if (tweetCache.size >= TWEET_CACHE_MAX) {
    const oldestKey = tweetCache.keys().next().value;
    if (oldestKey !== undefined) tweetCache.delete(oldestKey);
  }
  tweetCache.set(snapshotUrl, { tweet, expires: Date.now() + TWEET_CACHE_TTL_MS });
  return tweet;
}

// Streaming endpoint for progressive loading (paginated for infinite scroll)
app.get('/api/tweets/stream/:username', async (req, res) => {
  const username = req.params.username.replace(/^@/, '');
  const page = Math.max(0, parseInt(req.query.page, 10) || 0);
  
  // Set up Server-Sent Events
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control'
  });

  // When the client disconnects (e.g. infinite scroll opens the next page, or
  // the user navigates away), stop processing this page so we don't keep
  // hammering Wayback with fetches whose results nobody will see.
  let aborted = false;
  // Circuit breaker: once Wayback starts refusing connections, stop firing the
  // rest of this page's fetches (hammering a wall only prolongs the block).
  // Per-request scope means it resets on the next page — no sticky global block.
  let circuitOpen = false;
  let connectionFailures = 0;
  const BLOCK_THRESHOLD = 3;
  req.on('close', () => { aborted = true; });

  const sendEvent = (type, data) => {
    if (aborted) return;
    res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
  };

  try {
    // Full newest-first tweet list (cached); page N is a slice of it.
    const ordered = await getOrderedCaptures(username);
    const total = ordered.length;
    const { start, end } = pageRange(page);
    const pageCaptures = ordered.slice(start, end);
    const hasMore = end < total;

    // Tell the client up front how big this page is and whether more exist.
    sendEvent('meta', { total, page, hasMore, count: pageCaptures.length });
    sendEvent('progress', { total: pageCaptures.length, loaded: 0 });

    // Send identity (display name + avatar) once, as soon as we can recover it
    let profileSent = false;
    
    // Process this page's captures with concurrency control and streaming
    const tweetPromises = pageCaptures.map((cap, index) => {
      const snapshotUrl = `https://web.archive.org/web/${cap.timestamp}id_/${cap.url}`;
      return limit.run(async () => {
        // Bail before doing any network work if the client is gone or the
        // breaker already tripped (Wayback is refusing us).
        if (aborted || circuitOpen) return null;
        try {
          const tweet = await getTweet(snapshotUrl, cap.timestamp);
          if (aborted) return null;
          // A fetch that returned (even an empty parse) proves the connection is
          // alive, so the breaker counts only *consecutive* failures, not stray
          // resets scattered across an otherwise-healthy page.
          connectionFailures = 0;
          if (tweet && tweet.text && tweet.timestamp) {
            if (!profileSent && (tweet.displayName || tweet.avatarUrl)) {
              profileSent = true;
              sendEvent('profile', {
                handle: username,
                displayName: tweet.displayName,
                avatarUrl: tweet.avatarUrl,
              });
            }
            // Send tweet as it's processed
            sendEvent('tweet', {
              text: tweet.text,
              timestamp: tweet.timestamp,
              isReply: tweet.isReply,
              replyingTo: tweet.replyingTo,
              avatarUrl: tweet.avatarUrl,
              media: tweet.media,
            });
          }
          // Send progress update
          sendEvent('progress', { total: pageCaptures.length, loaded: index + 1 });
          return tweet;
        } catch (err) {
          if (isBlockError(err)) {
            connectionFailures++;
            if (!circuitOpen && connectionFailures >= BLOCK_THRESHOLD) {
              circuitOpen = true;
              console.warn(`Circuit opened for @${username}: Wayback refusing connections`);
              sendEvent('error', { message: 'The archive is rate-limiting requests right now. Wait a moment and try again.' });
            }
          }
          return null; // resolve so Promise.all settles; queued tasks see circuitOpen
        }
      });
    });
    
    console.log(`Processing page ${page} (${pageCaptures.length} snapshots) for @${username}...`);
    await Promise.all(tweetPromises);
    
    // Skip completion if the client left or the breaker tripped (error already sent).
    if (aborted || circuitOpen) return;
    // Send completion signal (with paging info so the client knows to keep going)
    sendEvent('complete', { page, hasMore });
    
  } catch (err) {
    console.error(`Error fetching tweets for @${username}:`, err.message);
    sendEvent('error', { message: err.message });
  } finally {
    res.end();
  }
});

// Keep original endpoint for backward compatibility
app.get('/api/tweets/:username', async (req, res) => {
  const username = req.params.username.replace(/^@/, '');
  
  // Check if there's already a request in progress for this username
  if (ongoingRequests.has(username)) {
    console.log(`Request already in progress for @${username}, waiting...`);
    try {
      const result = await ongoingRequests.get(username);
      return res.json(result);
    } catch (error) {
      ongoingRequests.delete(username);
      return res.status(500).json({ error: 'Previous request failed' });
    }
  }
  
  // Create a promise for this request
  const requestPromise = (async () => {
    try {
      const data = await fetchCDXData(username);
      
      const headers = data[0];
      const urlIdx = headers.indexOf('original');
      const tsIdx = headers.indexOf('timestamp');
      
      const captures = data.slice(1)
        .filter(row => row[urlIdx] && row[urlIdx].includes('/status/'))
        .map(row => ({
          url: row[urlIdx],
          timestamp: row[tsIdx],
        }));
      
      console.log(`Found ${captures.length} captures for @${username}`);

      // Collapse duplicate captures of the same tweet so we fetch each tweet once.
      const uniqueCaptures = dedupeCaptures(captures);
      console.log(`Deduped to ${uniqueCaptures.length} unique tweets for @${username}`);

      // Limit to most recent 100 unique tweets for performance
      const recentCaptures = uniqueCaptures.slice(-100);
      
      // Process captures with concurrency control
      const tweetPromises = recentCaptures.map(cap => {
        const snapshotUrl = `https://web.archive.org/web/${cap.timestamp}id_/${cap.url}`;
        return limit.run(() => getTweet(snapshotUrl, cap.timestamp));
      });
      
      console.log(`Processing ${recentCaptures.length} snapshots with concurrency control...`);
      const results = await Promise.all(tweetPromises);
      
      // Filter out null results and tweets without text
      const tweets = results
        .filter(tweet => tweet && tweet.text && tweet.timestamp)
        .map(tweet => ({
          text: tweet.text,
          timestamp: tweet.timestamp,
        }));
      
      // Sort newest to oldest
      tweets.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      
      console.log(`Successfully extracted ${tweets.length} tweets for @${username}`);
      return tweets;
      
    } catch (err) {
      console.error(`Error fetching tweets for @${username}:`, err.message);
      
      // Check if it's a timeout error
      if (err.code === 'ECONNABORTED' || err.message.includes('timeout')) {
        throw new Error('Request timeout - Wayback Machine is taking too long to respond. Please try again.');
      }
      
      // Check if it's a network error
      if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
        throw new Error('Wayback Machine is currently unavailable. Please try again later.');
      }
      
      throw new Error('Failed to fetch tweets');
    }
  })();
  
  // Store the promise and handle the response
  ongoingRequests.set(username, requestPromise);
  
  try {
    const tweets = await requestPromise;
    res.json(tweets);
  } catch (error) {
    if (error.message.includes('timeout')) {
      res.status(408).json({ error: error.message });
    } else if (error.message.includes('unavailable')) {
      res.status(503).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  } finally {
    ongoingRequests.delete(username);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
