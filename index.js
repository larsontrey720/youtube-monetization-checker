/**
 * YouTube Channel Monetization Detector
 * ======================================
 * Since YouTube removed the public `is_monetization_enabled` flag in Nov 2023,
 * this tool uses a multi-signal approach to infer monetization status:
 *
 *  Signal 1 – Channel page scrape → ytInitialData
 *    - Presence of Join/Membership button (sponsorshipsButton)
 *    - Subscriber count (must be ≥1,000 for full YPP ad revenue)
 *    - Channel age signals, family-safe flag
 *
 *  Signal 2 – InnerTube /player API (POST, no key needed)
 *    - Fetch player response for 2–3 recent videos > 4 min
 *    - Check `adPlacements` array in response
 *    - Pre-roll / mid-roll ad placements = strong monetization signal
 *
 *  Signal 3 – Channel page tab scrape
 *    - "Videos" tab: extract recent video IDs for Signal 2
 *    - Members-only content visible = membership is active
 *
 * Confidence scoring:
 *   Each signal contributes to a weighted confidence score (0–100).
 *   Final verdict: MONETIZED / LIKELY_MONETIZED / UNLIKELY / NOT_MONETIZED / UNKNOWN
 *
 * Usage:
 *   node index.js <channel_handle_or_url> [--json] [--verbose]
 *
 * Examples:
 *   node index.js @MrBeast
 *   node index.js https://www.youtube.com/@LinusTechTips --json
 *   node index.js UCX6OQ3DkcsbYNE6H8uQQuVA
 *
 * Programmatic usage:
 *   const { checkMonetization } = require('./index');
 *   const result = await checkMonetization('@MrBeast');
 */

'use strict';

const https = require('https');
const zlib = require('zlib');
const { URL } = require('url');

// ─── Constants ────────────────────────────────────────────────────────────────

const INNERTUBE_API_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8'; // Public WEB key
const INNERTUBE_CLIENT_VERSION = '2.20240101.09.00';

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':
    'text/html,application/xhtml+xml,application/xml;q=0.9,' +
    'image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Sec-Ch-Ua':
    '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
  // Consent bypass: pre-accepts cookies so YouTube doesn't redirect to consent gate.
  // SOCS=CAI is the minimal token that bypasses the EU/UK GDPR consent wall.
  // Without this, server/VM IPs get a 302 -> consent.youtube.com -> 400 cycle.
  'Cookie': 'SOCS=CAI; CONSENT=YES+cb; VISITOR_INFO1_LIVE=; PREF=tz=Europe.London&f6=40000000',
};

const INNERTUBE_HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Origin': 'https://www.youtube.com',
  'Referer': 'https://www.youtube.com/',
  'X-Youtube-Client-Name': '1',
  'X-Youtube-Client-Version': INNERTUBE_CLIENT_VERSION,
};

// Confidence weights (must sum to 100)
const WEIGHTS = {
  adsOnVideo: 50,      // Actual ads detected in player response (strongest signal)
  joinButton: 25,      // Join/membership button present
  subscriberCount: 15, // ≥1,000 subscribers (YPP requirement)
  memberContent: 10,   // Members-only content visible
};

// ─── HTTP Utilities ───────────────────────────────────────────────────────────

/**
 * GET request returning the decompressed body as a string.
 * Handles gzip/br/deflate transparently.
 * @param {string} url
 * @param {object} extraHeaders
 * @param {number} timeoutMs
 * @returns {Promise<{statusCode: number, body: string, headers: object}>}
 */
function httpGet(url, extraHeaders = {}, timeoutMs = 15000, _redirects = 0) {
  if (_redirects > 5) return Promise.reject(new Error('Too many redirects: ' + url));

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { ...BROWSER_HEADERS, ...extraHeaders },
      timeout: timeoutMs,
    };

    const req = https.request(options, (res) => {
      // Follow redirects (301/302/303/307/308) automatically
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        // Drain the response body so the socket is freed
        res.resume();
        let location = res.headers.location;
        // Resolve relative redirects
        if (!location.startsWith('http')) {
          location = `https://${parsed.hostname}${location}`;
        }
        return resolve(httpGet(location, extraHeaders, timeoutMs, _redirects + 1));
      }

      const encoding = res.headers['content-encoding'] || '';
      let stream = res;

      if (encoding === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());

      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          body: Buffer.concat(chunks).toString('utf-8'),
          headers: res.headers,
        });
      });
      stream.on('error', reject);
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`GET timeout: ${url}`)); });
    req.end();
  });
}

/**
 * POST JSON to InnerTube endpoint.
 * @param {string} endpoint  e.g. '/youtubei/v1/player'
 * @param {object} body
 * @param {number} timeoutMs
 * @returns {Promise<object>}  Parsed JSON response
 */
function innertubePost(endpoint, body, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: 'www.youtube.com',
      path: `${endpoint}?key=${INNERTUBE_API_KEY}&prettyPrint=false`,
      method: 'POST',
      headers: {
        ...INNERTUBE_HEADERS,
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: timeoutMs,
    };

    const req = https.request(options, (res) => {
      const encoding = res.headers['content-encoding'] || '';
      let stream = res;

      if (encoding === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());

      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
        } catch (e) {
          reject(new Error(`InnerTube JSON parse failed on ${endpoint}: ${e.message}`));
        }
      });
      stream.on('error', reject);
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`POST timeout: ${endpoint}`)); });
    req.write(payload);
    req.end();
  });
}

// ─── Input Normalisation ──────────────────────────────────────────────────────

/**
 * Accepts any of:
 *   @handle              → https://www.youtube.com/@handle
 *   handle (no @)        → https://www.youtube.com/@handle
 *   https://.../@handle  → used as-is
 *   https://.../channel/UCxxx → used as-is
 *   UCxxxxxxxxxxxxxxxxxxxxxxxx → https://www.youtube.com/channel/UCxxx
 *
 * @param {string} input
 * @returns {{ url: string, channelId: string|null, handle: string|null }}
 */
function normaliseInput(input) {
  input = input.trim();

  // Already a full URL
  if (input.startsWith('http://') || input.startsWith('https://')) {
    const parsed = new URL(input);
    const channelMatch = parsed.pathname.match(/^\/channel\/(UC[\w-]{22})/);
    const handleMatch = parsed.pathname.match(/^\/@([\w.-]+)/);
    return {
      url: `https://www.youtube.com${parsed.pathname}`,
      channelId: channelMatch ? channelMatch[1] : null,
      handle: handleMatch ? handleMatch[1] : null,
    };
  }

  // Channel ID (UC...)
  if (/^UC[\w-]{22}$/.test(input)) {
    return {
      url: `https://www.youtube.com/channel/${input}`,
      channelId: input,
      handle: null,
    };
  }

  // @handle or bare handle
  const handle = input.startsWith('@') ? input.slice(1) : input;
  return {
    url: `https://www.youtube.com/@${handle}`,
    channelId: null,
    handle,
  };
}

// ─── YouTube Data Extraction ──────────────────────────────────────────────────

/**
 * Extracts the ytInitialData JSON blob from a YouTube HTML page.
 * YouTube inlines it as: var ytInitialData = {...};
 * @param {string} html
 * @returns {object|null}
 */
function extractYtInitialData(html) {
  // Try window["ytInitialData"] pattern first, then var ytInitialData
  const patterns = [
    /window\["ytInitialData"\]\s*=\s*(\{.+?\});\s*(?:\/\/|<\/script>)/s,
    /var ytInitialData\s*=\s*(\{.+?\});\s*(?:\/\/|<\/script>)/s,
    /ytInitialData\s*=\s*(\{.+?\});\s*(?:\/\/|<\/script>)/s,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      try {
        return JSON.parse(match[1]);
      } catch {
        // Try a fallback: walk forward from ytInitialData= and find the balanced JSON object
        const idx = html.indexOf(match[0].split('=')[0] + '=');
        if (idx !== -1) {
          const start = html.indexOf('{', idx);
          if (start !== -1) {
            try {
              return extractBalancedJson(html, start);
            } catch { /* continue */ }
          }
        }
      }
    }
  }
  return null;
}

/**
 * Extracts a balanced JSON object from `str` starting at `startIdx`.
 * Handles nested braces/brackets correctly.
 * @param {string} str
 * @param {number} startIdx
 * @returns {object}
 */
function extractBalancedJson(str, startIdx) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIdx; i < str.length; i++) {
    const ch = str[i];

    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) {
        return JSON.parse(str.slice(startIdx, i + 1));
      }
    }
  }
  throw new Error('Unbalanced JSON object');
}

/**
 * Deeply searches a nested object for a key, returning all values found.
 * @param {object} obj
 * @param {string} key
 * @param {any[]} results  accumulator
 * @param {number} maxDepth
 * @returns {any[]}
 */
function deepFind(obj, key, results = [], maxDepth = 30) {
  if (maxDepth === 0 || obj === null || typeof obj !== 'object') return results;
  if (Array.isArray(obj)) {
    for (const item of obj) deepFind(item, key, results, maxDepth - 1);
    return results;
  }
  for (const k of Object.keys(obj)) {
    if (k === key) results.push(obj[k]);
    deepFind(obj[k], key, results, maxDepth - 1);
  }
  return results;
}

// ─── Signal Extractors ────────────────────────────────────────────────────────

/**
 * Signal 1a: Check for Join/Membership button in ytInitialData.
 * @param {object} data  ytInitialData
 * @returns {{ found: boolean, details: string }}
 */
function detectJoinButton(data) {
  // Look for sponsorshipsButton, buttonRenderer with JOIN text, or membership-related keys
  const str = JSON.stringify(data);

  const joinPatterns = [
    'sponsorshipsButton',
    'membershipButton',
    '"JOIN"',
    '"Join"',
    'SPONSOR_BUTTON',
    'membershipsButton',
  ];

  for (const pattern of joinPatterns) {
    if (str.includes(pattern)) {
      return { found: true, details: `Matched pattern: ${pattern}` };
    }
  }

  // Also search for buttonRenderer with text "Join"
  const buttonRenderers = deepFind(data, 'buttonRenderer');
  for (const btn of buttonRenderers) {
    const text = JSON.stringify(btn?.text || btn?.navigationEndpoint || '');
    if (/\bjoin\b/i.test(text)) {
      return { found: true, details: 'buttonRenderer with "Join" text found' };
    }
  }

  return { found: false, details: 'No Join button signals detected' };
}

/**
 * Signal 1b: Extract subscriber count from ytInitialData.
 * @param {object} data
 * @returns {{ count: number|null, raw: string|null }}
 */
function extractSubscriberCount(data) {
  // Multiple locations YouTube uses across versions
  const paths = [
    ['header', 'c4TabbedHeaderRenderer', 'subscriberCountText', 'simpleText'],
    ['header', 'c4TabbedHeaderRenderer', 'subscriberCountText', 'runs', 0, 'text'],
    ['metadata', 'channelMetadataRenderer', 'subscriberCount'],
    ['header', 'pageHeaderRenderer', 'content', 'pageHeaderViewModel', 'metadata', 'contentMetadataViewModel', 'metadataRows'],
  ];

  let rawText = null;

  // Try direct paths first
  for (const path of paths) {
    let node = data;
    let found = true;
    for (const key of path) {
      if (node && typeof node === 'object' && key in node) {
        node = node[key];
      } else {
        found = false;
        break;
      }
    }
    if (found && typeof node === 'string') {
      rawText = node;
      break;
    }
    if (found && Array.isArray(node)) {
      // metadataRows structure
      const str = JSON.stringify(node);
      const m = str.match(/(\d[\d,.]*[KMBkmb]?)\s*subscribers/i);
      if (m) { rawText = m[1]; break; }
    }
  }

  // Fallback: search entire JSON string
  if (!rawText) {
    const str = JSON.stringify(data);
    const m = str.match(/"([\d,.]+[KMBkmb]?)\s*(?:subscriber|abonné|subscriber)/i);
    if (m) rawText = m[1];
  }

  if (!rawText) return { count: null, raw: null };

  return { count: parseSubscriberText(rawText), raw: rawText };
}

/**
 * Parses subscriber text like "250M", "1.2K", "14,500" → integer.
 * @param {string} text
 * @returns {number}
 */
function parseSubscriberText(text) {
  const clean = text.replace(/,/g, '').trim().toUpperCase();
  if (clean.endsWith('B')) return Math.round(parseFloat(clean) * 1_000_000_000);
  if (clean.endsWith('M')) return Math.round(parseFloat(clean) * 1_000_000);
  if (clean.endsWith('K')) return Math.round(parseFloat(clean) * 1_000);
  return parseInt(clean, 10) || 0;
}

/**
 * Signal 1c: Check for members-only content indicators in page HTML or data.
 * @param {string} html
 * @param {object} data  ytInitialData
 * @returns {{ found: boolean, details: string }}
 */
function detectMembersContent(html, data) {
  const htmlSignals = [
    'membersOnly',
    'members-only',
    'MEMBERS_ONLY',
    'member only',
    'Members only',
  ];

  for (const s of htmlSignals) {
    if (html.includes(s)) {
      return { found: true, details: `HTML contains "${s}"` };
    }
  }

  const str = JSON.stringify(data || {});
  if (str.includes('membersOnly') || str.includes('MEMBERS_ONLY')) {
    return { found: true, details: 'ytInitialData contains members-only marker' };
  }

  return { found: false, details: 'No members-only content detected' };
}

/**
 * Extract recent video IDs from the raw page HTML.
 *
 * Uses a regex on the raw HTML string rather than walking parsed ytInitialData.
 * This is renderer-agnostic and handles all YouTube layout variants:
 *   - videoRenderer        (standard layout)
 *   - richItemRenderer     (most channels since 2022)
 *   - gridVideoRenderer    (older layout)
 *   - reelItemRenderer     (Shorts)
 *   - shortsLockupViewModel (new Shorts layout)
 *
 * Falls back to deepFind on ytInitialData if raw extraction yields nothing.
 *
 * @param {string} rawHtml  Raw page HTML string
 * @param {object|null} data  ytInitialData (fallback)
 * @param {number} limit
 * @returns {string[]}
 */
function extractVideoIds(rawHtml, data, limit = 10) {
  const seen = new Set();
  const ids = [];

  // Primary: regex scan of raw HTML — works across all renderer types.
  // YouTube video IDs are exactly 11 chars from [a-zA-Z0-9_-].
  const idMatches = (rawHtml || '').matchAll(/"videoId":"([a-zA-Z0-9_-]{11})"/g);
  for (const m of idMatches) {
    const id = m[1];
    // Channel IDs start with UC — skip them
    if (!seen.has(id) && !id.startsWith('UC')) {
      seen.add(id);
      ids.push(id);
    }
  }

  // Fallback: deepFind on ytInitialData if raw extraction missed everything
  if (ids.length === 0 && data) {
    for (const key of ['videoRenderer', 'gridVideoRenderer', 'reelItemRenderer']) {
      const renderers = deepFind(data, key);
      for (const v of renderers) {
        if (v?.videoId && !seen.has(v.videoId) && !v.videoId.startsWith('UC')) {
          seen.add(v.videoId);
          ids.push(v.videoId);
        }
      }
    }
  }

  return ids.slice(0, limit);
}

/**
 * Parse "4:32" or "1:23:45" → seconds.
 * @param {string} text
 * @returns {number}
 */
function parseDurationText(text) {
  if (!text) return 0;
  const parts = text.split(':').map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

/**
 * Signal 2: Call InnerTube /player for a video and check for adPlacements.
 * Tries multiple client contexts in order — some videos are LOGIN_REQUIRED
 * on the WEB client but return fine on TVHTML5 or IOS (no auth needed).
 * @param {string} videoId
 * @param {number} timeoutMs
 * @returns {Promise<{ hasAds: boolean, adTypes: string[], error: string|null, client: string|null }>}
 */
async function checkVideoForAds(videoId, timeoutMs = 15000) {
  // Client contexts to try in order.
  // TVHTML5 and IOS don't require authentication for public videos and
  // bypass the LOGIN_REQUIRED gate that WEB hits on some channels.
  // ANDROID is included as a third fallback.
  const clients = [
    {
      name: 'TVHTML5',
      body: {
        videoId,
        context: {
          client: {
            clientName: 'TVHTML5',
            clientVersion: '7.20240101.08.01',
            hl: 'en',
            gl: 'US',
            utcOffsetMinutes: 0,
          },
        },
        racyCheckOk: true,
        contentCheckOk: true,
      },
    },
    {
      name: 'IOS',
      body: {
        videoId,
        context: {
          client: {
            clientName: 'IOS',
            clientVersion: '19.09.3',
            deviceMake: 'Apple',
            deviceModel: 'iPhone16,2',
            userAgent: 'com.google.ios.youtube/19.09.3 (iPhone; CPU iPhone OS 17_4 like Mac OS X)',
            osName: 'iPhone',
            osVersion: '17.4.0.21E219',
            hl: 'en',
            gl: 'US',
            utcOffsetMinutes: 0,
          },
        },
        racyCheckOk: true,
        contentCheckOk: true,
      },
    },
    {
      name: 'WEB',
      body: {
        videoId,
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: '2.20240101.09.00',
            hl: 'en',
            gl: 'US',
            userAgent:
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
              '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36,gzip(gfe)',
            browserName: 'Chrome',
            browserVersion: '124.0.0.0',
            osName: 'Windows',
            osVersion: '10.0',
            platform: 'DESKTOP',
            utcOffsetMinutes: 0,
          },
        },
        playbackContext: {
          contentPlaybackContext: { signatureTimestamp: 19950 },
        },
        racyCheckOk: true,
        contentCheckOk: true,
      },
    },
    {
      name: 'ANDROID',
      body: {
        videoId,
        context: {
          client: {
            clientName: 'ANDROID',
            clientVersion: '18.11.34',
            androidSdkVersion: 30,
            userAgent: 'com.google.android.youtube/18.11.34(Linux; U; Android 11) gzip',
            hl: 'en',
            gl: 'US',
            utcOffsetMinutes: 0,
          },
        },
        racyCheckOk: true,
        contentCheckOk: true,
      },
    },
  ];

  const errors = [];

  for (const client of clients) {
    try {
      const response = await innertubePost('/youtubei/v1/player', client.body, timeoutMs);

      if (!response || typeof response !== 'object') {
        errors.push(`${client.name}: empty response`);
        continue;
      }

      const status = response?.playabilityStatus?.status;

      // Skip unplayable / login-required / private — try next client
      if (status && !['OK', 'CONTENT_CHECK_REQUIRED'].includes(status)) {
        errors.push(`${client.name}: ${status}`);
        continue;
      }

      // Got a playable response — check for ads
      if (Array.isArray(response.adPlacements) && response.adPlacements.length > 0) {
        const adTypes = response.adPlacements
          .map((p) => p?.adPlacementConfig?.kind || 'UNKNOWN')
          .filter(Boolean);
        return { hasAds: true, adTypes, error: null, client: client.name };
      }

      // Playable but no ads — this is a valid "no ads" result
      return { hasAds: false, adTypes: [], error: null, client: client.name };

    } catch (err) {
      errors.push(`${client.name}: ${err.message}`);
    }
  }

  // All clients failed
  return { hasAds: false, adTypes: [], error: errors.join(' | '), client: null };
}

// ─── Channel Page Scraper ─────────────────────────────────────────────────────

/**
 * Fetches the channel page HTML and extracts ytInitialData.
 * @param {string} channelUrl
 * @param {boolean} verbose
 * @returns {Promise<{ html: string, data: object|null, finalUrl: string }>}
 */
async function fetchChannelPage(channelUrl, verbose = false) {
  // Always hit the /videos tab — it surfaces videoRenderers reliably
  const videosUrl = channelUrl.replace(/\/$/, '') + '/videos';

  if (verbose) console.error(`[fetch] GET ${videosUrl}`);

  // httpGet follows redirects automatically (handles consent.youtube.com 302s)
  const { statusCode, body } = await httpGet(videosUrl);

  if (verbose) console.error(`[fetch] Status: ${statusCode}, length: ${body.length}`);

  // Detect consent gate: YouTube returns 200 but with a consent page body
  if (body.includes('consent.youtube.com') || body.includes('Before you continue to YouTube')) {
    throw new Error('YouTube consent gate not bypassed — SOCS cookie may be stale');
  }

  if (statusCode !== 200) {
    throw new Error(`Channel page returned HTTP ${statusCode} for ${videosUrl}`);
  }

  const data = extractYtInitialData(body);

  if (!data && verbose) {
    console.error('[fetch] WARNING: ytInitialData not found in page. First 500 chars:');
    console.error(body.slice(0, 500));
  }

  return { html: body, data, finalUrl: videosUrl };
}

// ─── Confidence Scoring ───────────────────────────────────────────────────────

/**
 * @typedef {object} MonetizationResult
 * @property {string} verdict  MONETIZED | LIKELY_MONETIZED | UNLIKELY | NOT_MONETIZED | UNKNOWN
 * @property {number} confidence  0–100
 * @property {object} signals
 * @property {object} channelInfo
 * @property {string[]} errors
 */

/**
 * Compute a weighted confidence score from individual signal results.
 * @param {object} signals
 * @returns {{ confidence: number, verdict: string }}
 */
function computeVerdict(signals) {
  let confidence = 0;

  // Ads detected = strongest positive signal (+50)
  // Ads explicitly checked but none found = strong negative signal (-30)
  // Ads not checked at all (null) = no contribution either way
  if (signals.adsDetected === true) {
    confidence += WEIGHTS.adsOnVideo;
  } else if (signals.adsDetected === false && signals.videosChecked > 0) {
    // We checked real videos and found zero ads — meaningful negative evidence.
    // Weight scales with how many videos were checked (more checks = more confident).
    const penalty = Math.min(30, signals.videosChecked * 10);
    confidence -= penalty;
  }

  // Join button = strong positive (+25)
  if (signals.joinButton === true) confidence += WEIGHTS.joinButton;

  // Subscriber count: ≥1000 is necessary for YPP but not sufficient (+15)
  // <500 is a hard disqualifier (-15)
  if (signals.subscriberCount !== null) {
    if (signals.subscriberCount >= 1000) confidence += WEIGHTS.subscriberCount;
    else if (signals.subscriberCount < 500) confidence -= 15;
  }

  // Members-only content visible = monetization confirmed (+10)
  if (signals.membersContent === true) confidence += WEIGHTS.memberContent;

  confidence = Math.max(0, Math.min(100, confidence));

  let verdict;
  if (confidence >= 70) {
    verdict = 'MONETIZED';
  } else if (confidence >= 45) {
    verdict = 'LIKELY_MONETIZED';
  } else if (confidence >= 20) {
    verdict = 'UNLIKELY';
  } else if (
    signals.adsDetected === false &&
    signals.videosChecked > 0 &&
    signals.joinButton === false &&
    signals.membersContent === false
  ) {
    // Explicitly checked for ads + found nothing + no membership signals = strong NOT_MONETIZED
    verdict = 'NOT_MONETIZED';
  } else if (signals.subscriberCount !== null && signals.subscriberCount < 500) {
    verdict = 'NOT_MONETIZED';
  } else {
    verdict = 'UNKNOWN';
  }

  return { confidence, verdict };
}

// ─── Main Checker ─────────────────────────────────────────────────────────────

/**
 * Check whether a YouTube channel is monetized.
 *
 * @param {string} channelInput  Handle, URL, or channel ID
 * @param {object} options
 * @param {boolean} [options.verbose]       Log debug info to stderr
 * @param {number}  [options.videoSamples]  How many videos to check for ads (default: 3)
 * @param {number}  [options.timeoutMs]     Per-request timeout in ms (default: 15000)
 * @returns {Promise<MonetizationResult>}
 */
async function checkMonetization(channelInput, options = {}) {
  const { verbose = false, videoSamples = 3, timeoutMs = 15000 } = options;

  const { url, channelId, handle } = normaliseInput(channelInput);

  const result = {
    verdict: 'UNKNOWN',
    confidence: 0,
    channel: {
      input: channelInput,
      url,
      handle: handle || null,
      channelId: channelId || null,
      title: null,
      subscribers: null,
      subscriberCount: null,
    },
    signals: {
      joinButton: null,
      joinButtonDetails: null,
      adsDetected: null,
      adTypes: [],
      videosChecked: 0,
      videoResults: [],
      membersContent: null,
      subscriberCount: null,
      subscriberRaw: null,
    },
    errors: [],
    checkedAt: new Date().toISOString(),
  };

  // ── Step 1: Fetch channel page ──────────────────────────────────────────────
  let html, pageData;
  try {
    const res = await fetchChannelPage(url, verbose);
    html = res.html;
    pageData = res.data;

    if (!pageData) {
      result.errors.push('Could not extract ytInitialData from channel page');
    }
  } catch (err) {
    result.errors.push(`Channel page fetch failed: ${err.message}`);
    return result;
  }

  // ── Step 2: Extract channel metadata ───────────────────────────────────────
  if (pageData) {
    // Title
    const titlePaths = [
      ['metadata', 'channelMetadataRenderer', 'title'],
      ['header', 'c4TabbedHeaderRenderer', 'title'],
      ['header', 'pageHeaderRenderer', 'pageTitle'],
    ];
    for (const path of titlePaths) {
      let node = pageData;
      let ok = true;
      for (const k of path) { if (node?.[k] !== undefined) node = node[k]; else { ok = false; break; } }
      if (ok && typeof node === 'string') { result.channel.title = node; break; }
    }

    // Subscriber count
    const subResult = extractSubscriberCount(pageData);
    result.signals.subscriberCount = subResult.count;
    result.signals.subscriberRaw = subResult.raw;
    result.channel.subscriberCount = subResult.count;
    result.channel.subscribers = subResult.raw;

    if (verbose) {
      console.error(`[signals] Channel title: ${result.channel.title}`);
      console.error(`[signals] Subscribers: ${subResult.raw} (${subResult.count})`);
    }

    // ── Signal: Join button ─────────────────────────────────────────────────
    const joinResult = detectJoinButton(pageData);
    result.signals.joinButton = joinResult.found;
    result.signals.joinButtonDetails = joinResult.details;
    if (verbose) console.error(`[signals] Join button: ${joinResult.found} — ${joinResult.details}`);

    // ── Signal: Members content ─────────────────────────────────────────────
    const membersResult = detectMembersContent(html, pageData);
    result.signals.membersContent = membersResult.found;
    if (verbose) console.error(`[signals] Members content: ${membersResult.found} — ${membersResult.details}`);

    // ── Step 3: Extract video IDs for ad checking ───────────────────────────
    const videoIds = extractVideoIds(html, pageData, videoSamples);
    if (verbose) console.error(`[signals] Found ${videoIds.length} video IDs to check: ${videoIds.join(', ')}`);

    if (videoIds.length === 0) {
      result.errors.push('No video IDs found on channel page — cannot check for ads');
    } else {
      // ── Signal: Ads on videos (parallel) ──────────────────────────────────
      const adChecks = await Promise.allSettled(
        videoIds.map((id) => checkVideoForAds(id, timeoutMs))
      );

      let anyAds = false;
      for (let i = 0; i < adChecks.length; i++) {
        const check = adChecks[i];
        const videoId = videoIds[i];

        if (check.status === 'fulfilled') {
          const { hasAds, adTypes, error } = check.value;
          result.signals.videosChecked++;
          result.signals.videoResults.push({ videoId, hasAds, adTypes, error, client: check.value.client });

          if (verbose) {
            console.error(
              `[ads] Video ${videoId} (client=${check.value.client}): hasAds=${hasAds} types=[${adTypes.join(',')}] ${error ? `err=${error}` : ''}`
            );
          }

          if (hasAds) anyAds = true;
        } else {
          result.errors.push(`Ad check for ${videoId} rejected: ${check.reason?.message}`);
          result.signals.videoResults.push({ videoId, hasAds: false, adTypes: [], error: check.reason?.message });
        }
      }

      // adsDetected = true if at least 1 video had ads
      // null if ALL checks errored (can't conclude)
      const allErrored = result.signals.videoResults.every((r) => r.error && !r.hasAds);
      result.signals.adsDetected = allErrored && !anyAds ? null : anyAds;
    }
  }

  // ── Step 4: Compute verdict ─────────────────────────────────────────────────
  const { confidence, verdict } = computeVerdict(result.signals);
  result.confidence = confidence;
  result.verdict = verdict;

  return result;
}

// ─── Pretty Printer ───────────────────────────────────────────────────────────

const VERDICT_EMOJI = {
  MONETIZED: '✅',
  LIKELY_MONETIZED: '🟡',
  UNLIKELY: '🔴',
  NOT_MONETIZED: '❌',
  UNKNOWN: '⚓',
};

const VERDICT_DESC = {
  MONETIZED: 'Channel is monetized (high confidence)',
  LIKELY_MONETIZED: 'Channel is likely monetized',
  UNLIKELY: 'Channel is unlikely to be monetized',
  NOT_MONETIZED: 'Channel does not meet YPP requirements',
  UNKNOWN: 'Could not determine monetization status',
};

function printResult(result) {
  const emoji = VERDICT_EMOJI[result.verdict] || '❓';
  const desc = VERDICT_DESC[result.verdict] || result.verdict;

  console.log('');
  console.log('══════════════════════════════════════════════════');
  console.log(` YouTube Monetization Check`);
  console.log('══════════════════════════════════════════════════');
  console.log(` Channel : ${result.channel.title || result.channel.input}`);
  if (result.channel.subscribers) {
    console.log(` Subs    : ${result.channel.subscribers}`);
  }
  console.log(` URL     : ${result.channel.url}`);
  console.log('──────────────────────────────────────────────────');
  console.log(` ${emoji}  ${desc}`);
  console.log(` Confidence: ${result.confidence}%`);
  console.log('──────────────────────────────────────────────────');
  console.log(' Signals:');
  console.log(`   Ads on videos   : ${result.signals.adsDetected === null ? '— (not checked)' : result.signals.adsDetected ? `YES (${result.signals.videoResults.filter(v=>v.hasAds).length}/${result.signals.videosChecked} videos)` : `NO (${result.signals.videosChecked} videos checked)`}`);
  console.log(`   Join button     : ${result.signals.joinButton === null ? '—' : result.signals.joinButton ? 'YES' : 'NO'}`);
  console.log(`   Members content : ${result.signals.membersContent === null ? '—' : result.signals.membersContent ? 'YES' : 'NO'}`);
  console.log(`   Subscriber req  : ${result.signals.subscriberCount === null ? '— (unknown)' : result.signals.subscriberCount >= 1000 ? `YES (${result.signals.subscriberRaw})` : `NO (${result.signals.subscriberRaw} — need ≥1,000)`}`);

  if (result.signals.videoResults.length > 0) {
    console.log('');
    console.log(' Video ad check results:');
    for (const v of result.signals.videoResults) {
      const clientTag = v.client ? ` [${v.client}]` : '';
      const status = v.error && !v.hasAds ? `⚠️  error: ${v.error}` : v.hasAds ? `✅ ads: [${v.adTypes.join(', ')}]${clientTag}` : `❌ no ads${clientTag}`;
      console.log(`   ${v.videoId}  ${status}`);
    }
  }

  if (result.errors.length > 0) {
    console.log('');
    console.log(' Warnings/Errors:');
    for (const e of result.errors) console.log(`   ⚠️  ${e}`);
  }

  console.log('──────────────────────────────────────────────────');
  console.log(` Checked at: ${result.checkedAt}`);
  console.log('══════════════════════════════════════════════════');
  console.log('');
}

// ─── CLI Entry Point ──────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');
  const verbose = args.includes('--verbose') || args.includes('-v');
  const channelArgs = args.filter((a) => !a.startsWith('--') && a !== '-v');

  if (channelArgs.length === 0) {
    console.error('Usage: node index.js <channel_handle_or_url> [--json] [--verbose]');
    console.error('');
    console.error('Examples:');
    console.error('  node index.js @MrBeast');
    console.error('  node index.js https://www.youtube.com/@LinusTechTips --json');
    console.error('  node index.js UCX6OQ3DkcsbYNE6H8uQQuVA --verbose');
    process.exit(1);
  }

  const channelInput = channelArgs[0];

  if (!jsonOutput) {
    console.log(`\nChecking monetization for: ${channelInput} …`);
  }

  try {
    const result = await checkMonetization(channelInput, { verbose, videoSamples: 3 });

    if (jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printResult(result);
    }

    // Exit code reflects verdict: 0=monetized, 1=not/unknown
    process.exit(result.verdict === 'MONETIZED' || result.verdict === 'LIKELY_MONETIZED' ? 0 : 1);
  } catch (err) {
    console.error('Fatal error:', err.message);
    if (verbose) console.error(err.stack);
    process.exit(2);
  }
}

// Run CLI if invoked directly
if (require.main === module) {
  main();
}

// Exports for programmatic use
module.exports = { checkMonetization, normaliseInput, parseSubscriberText };
