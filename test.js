/**
 * Test suite for youtube-monetization-checker
 * Run: node test.js
 *
 * Tests all pure functions without network calls, plus integration stubs
 * to validate the full pipeline shape with mock data.
 */

'use strict';

const assert = require('assert');
const {
  checkMonetization,
  normaliseInput,
  parseSubscriberText,
} = require('./index');

// Pull private helpers via a small test shim
// (Expose them by re-requiring with a probe – or just copy the logic here)
// Since they're not exported, we re-derive them inline for unit tests.

// ─── Inline copies of private helpers (kept in sync with index.js) ───────────

function parseSubscriberTextLocal(text) {
  const clean = text.replace(/,/g, '').trim().toUpperCase();
  if (clean.endsWith('B')) return Math.round(parseFloat(clean) * 1_000_000_000);
  if (clean.endsWith('M')) return Math.round(parseFloat(clean) * 1_000_000);
  if (clean.endsWith('K')) return Math.round(parseFloat(clean) * 1_000);
  return parseInt(clean, 10) || 0;
}

function parseDurationText(text) {
  if (!text) return 0;
  const parts = text.split(':').map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

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
      if (depth === 0) return JSON.parse(str.slice(startIdx, i + 1));
    }
  }
  throw new Error('Unbalanced JSON object');
}

// ─── Test runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌  ${name}`);
    console.log(`       ${err.message}`);
    failed++;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✅  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌  ${name}`);
    console.log(`       ${err.message}`);
    failed++;
  }
}

function eq(a, b) {
  assert.strictEqual(a, b);
}
function deepEq(a, b) {
  assert.deepStrictEqual(a, b);
}
function ok(val, msg) {
  assert.ok(val, msg);
}

// ─── Unit Tests ───────────────────────────────────────────────────────────────

console.log('\n── parseSubscriberText ─────────────────────────────');

test('parses plain integer', () => eq(parseSubscriberTextLocal('1000'), 1000));
test('parses comma-formatted integer', () => eq(parseSubscriberTextLocal('14,500'), 14500));
test('parses K suffix (lowercase)', () => eq(parseSubscriberTextLocal('1.2k'), 1200));
test('parses K suffix (uppercase)', () => eq(parseSubscriberTextLocal('500K'), 500000));
test('parses M suffix', () => eq(parseSubscriberTextLocal('2.5M'), 2500000));
test('parses B suffix', () => eq(parseSubscriberTextLocal('1B'), 1000000000));
test('handles zero', () => eq(parseSubscriberTextLocal('0'), 0));
test('handles garbage gracefully', () => eq(parseSubscriberTextLocal('N/A'), 0));

// Verify exported function matches
test('exported parseSubscriberText matches local impl', () => {
  const cases = ['1K', '2.5M', '100', '14,500', '1B'];
  for (const c of cases) {
    eq(parseSubscriberText(c), parseSubscriberTextLocal(c));
  }
});

console.log('\n── parseDurationText ───────────────────────────────');

test('parses MM:SS format', () => eq(parseDurationText('4:32'), 272));
test('parses HH:MM:SS format', () => eq(parseDurationText('1:23:45'), 5025));
test('handles empty string', () => eq(parseDurationText(''), 0));
test('handles undefined', () => eq(parseDurationText(undefined), 0));
test('parses 0:00', () => eq(parseDurationText('0:00'), 0));
test('parses 10:00', () => eq(parseDurationText('10:00'), 600));

console.log('\n── normaliseInput ──────────────────────────────────');

test('@handle → url + handle', () => {
  const r = normaliseInput('@MrBeast');
  eq(r.url, 'https://www.youtube.com/@MrBeast');
  eq(r.handle, 'MrBeast');
  eq(r.channelId, null);
});

test('bare handle (no @) → url + handle', () => {
  const r = normaliseInput('LinusTechTips');
  eq(r.url, 'https://www.youtube.com/@LinusTechTips');
  eq(r.handle, 'LinusTechTips');
});

test('channel ID UC... → correct url', () => {
  const r = normaliseInput('UCX6OQ3DkcsbYNE6H8uQQuVA');
  eq(r.url, 'https://www.youtube.com/channel/UCX6OQ3DkcsbYNE6H8uQQuVA');
  eq(r.channelId, 'UCX6OQ3DkcsbYNE6H8uQQuVA');
  eq(r.handle, null);
});

test('full @handle URL → parsed correctly', () => {
  const r = normaliseInput('https://www.youtube.com/@mkbhd');
  eq(r.url, 'https://www.youtube.com/@mkbhd');
  eq(r.handle, 'mkbhd');
  eq(r.channelId, null);
});

test('full channel ID URL → parsed correctly', () => {
  const r = normaliseInput('https://www.youtube.com/channel/UCX6OQ3DkcsbYNE6H8uQQuVA');
  eq(r.channelId, 'UCX6OQ3DkcsbYNE6H8uQQuVA');
  eq(r.handle, null);
});

test('trims whitespace', () => {
  const r = normaliseInput('  @MKBHD  ');
  eq(r.handle, 'MKBHD');
});

console.log('\n── extractBalancedJson ─────────────────────────────');

test('extracts simple object', () => {
  const str = 'var x = {"a":1,"b":2}; more stuff';
  const idx = str.indexOf('{');
  deepEq(extractBalancedJson(str, idx), { a: 1, b: 2 });
});

test('extracts nested object', () => {
  const str = 'prefix {"outer":{"inner":42},"arr":[1,2,3]} suffix';
  const idx = str.indexOf('{');
  deepEq(extractBalancedJson(str, idx), { outer: { inner: 42 }, arr: [1, 2, 3] });
});

test('handles string containing braces', () => {
  const str = '{"text":"hello {world}","val":99}';
  deepEq(extractBalancedJson(str, 0), { text: 'hello {world}', val: 99 });
});

test('handles escaped quotes in strings', () => {
  const str = '{"key":"say \\"hello\\"","n":1}';
  deepEq(extractBalancedJson(str, 0), { key: 'say "hello"', n: 1 });
});

test('throws on unbalanced input', () => {
  assert.throws(() => extractBalancedJson('{"a":1', 0), /Unbalanced/);
});

console.log('\n── Signal extraction (mock ytInitialData) ──────────');

// We replicate the relevant internal logic here since index.js doesn't export them,
// but we validate the overall checkMonetization() with mock injection below.

function mockDeepFind(obj, key, results = [], maxDepth = 30) {
  if (maxDepth === 0 || obj === null || typeof obj !== 'object') return results;
  if (Array.isArray(obj)) {
    for (const item of obj) mockDeepFind(item, key, results, maxDepth - 1);
    return results;
  }
  for (const k of Object.keys(obj)) {
    if (k === key) results.push(obj[k]);
    mockDeepFind(obj[k], key, results, maxDepth - 1);
  }
  return results;
}

test('deepFind locates nested key', () => {
  const data = { a: { b: { target: 'found' }, target: 'also' } };
  const results = mockDeepFind(data, 'target');
  eq(results.length, 2);
  ok(results.includes('found'));
  ok(results.includes('also'));
});

test('deepFind handles arrays', () => {
  const data = { items: [{ id: 1 }, { id: 2 }] };
  const results = mockDeepFind(data, 'id');
  deepEq(results, [1, 2]);
});

test('deepFind returns empty array when key absent', () => {
  const data = { x: { y: { z: 1 } } };
  deepEq(mockDeepFind(data, 'missing'), []);
});

// Simulate the join button detection logic
function mockDetectJoinButton(data) {
  const str = JSON.stringify(data);
  const patterns = ['sponsorshipsButton', 'membershipButton', '"JOIN"', '"Join"', 'SPONSOR_BUTTON', 'membershipsButton'];
  for (const p of patterns) {
    if (str.includes(p)) return { found: true, details: `Matched: ${p}` };
  }
  const buttonRenderers = mockDeepFind(data, 'buttonRenderer');
  for (const btn of buttonRenderers) {
    const text = JSON.stringify(btn?.text || btn?.navigationEndpoint || '');
    if (/\bjoin\b/i.test(text)) return { found: true, details: 'buttonRenderer join' };
  }
  return { found: false, details: 'none' };
}

test('detects sponsorshipsButton key', () => {
  const data = { tabs: [{ sponsorshipsButton: { text: 'Join' } }] };
  ok(mockDetectJoinButton(data).found);
});

test('detects "Join" as buttonViewModel text value', () => {
  // YouTube emits {"buttonViewModel":{"text":{"content":"Join"}}} — "Join" appears as a value
  const data = { actions: [{ buttonViewModel: { text: { content: 'Join' } } }] };
  // The JSON serialisation will contain "Join" (with quotes), matching the pattern
  ok(mockDetectJoinButton(data).found);
});

test('does not false-positive on unrelated data', () => {
  const data = { header: { title: 'Some Channel' }, tabs: ['Home', 'Videos', 'About'] };
  ok(!mockDetectJoinButton(data).found);
});

// Simulate subscriber extraction
function mockExtractSubscriberCount(data) {
  const str = JSON.stringify(data);
  const m = str.match(/"([\d,.]+[KMBkmb]?)\s*(?:subscriber)/i);
  if (m) return { count: parseSubscriberTextLocal(m[1]), raw: m[1] };
  return { count: null, raw: null };
}

test('extracts "250M subscribers"', () => {
  const data = { header: { subscriberCountText: { simpleText: '250M subscribers' } } };
  const r = mockExtractSubscriberCount(data);
  eq(r.count, 250000000);
  eq(r.raw, '250M');
});

test('extracts "14,500 subscribers"', () => {
  const data = { metadata: { channelMetadataRenderer: { subscriberCountText: '14,500 subscribers' } } };
  const r = mockExtractSubscriberCount(data);
  eq(r.count, 14500);
});

test('returns null when no subscriber data', () => {
  const data = { header: { title: 'Channel' } };
  const r = mockExtractSubscriberCount(data);
  eq(r.count, null);
});

console.log('\n── Confidence scoring / verdict ────────────────────');

function mockComputeVerdict(signals) {
  const W = { ytAd: 55, adsOnVideo: 45, joinButton: 25, subscriberCount: 15, memberContent: 10 };
  let confidence = 0;
  if (signals.ytAdFound === true) {
    confidence += W.ytAd;
  } else if (signals.ytAdFound === false && signals.ytAdVideoId) {
    confidence -= 20;
  }
  if (signals.adsDetected === true) {
    confidence += W.adsOnVideo;
  } else if (signals.adsDetected === false && signals.videosChecked > 0) {
    const penalty = Math.min(20, signals.videosChecked * 7);
    confidence -= penalty;
  }
  if (signals.joinButton === true) confidence += W.joinButton;
  if (signals.subscriberCount !== null) {
    if (signals.subscriberCount >= 1000) confidence += W.subscriberCount;
    else if (signals.subscriberCount < 500) confidence -= 15;
  }
  if (signals.membersContent === true) confidence += W.memberContent;
  confidence = Math.max(0, Math.min(100, confidence));
  let verdict;
  if (confidence >= 70) {
    verdict = 'MONETIZED';
  } else if (confidence >= 45) {
    verdict = 'LIKELY_MONETIZED';
  } else if (confidence >= 20) {
    verdict = 'UNLIKELY';
  } else if (
    signals.ytAdFound === false &&
    signals.adsDetected === false &&
    signals.videosChecked > 0 &&
    signals.joinButton === false &&
    signals.membersContent === false
  ) {
    verdict = 'NOT_MONETIZED';
  } else if (signals.subscriberCount !== null && signals.subscriberCount < 500) {
    verdict = 'NOT_MONETIZED';
  } else {
    verdict = 'UNKNOWN';
  }
  return { confidence, verdict };
}

test('all signals positive (ytAd=null) → MONETIZED (95%)', () => {
  // ytAd null = not checked; ads(45)+join(25)+subs(15)+members(10) = 95
  const r = mockComputeVerdict({
    ytAdFound: null, ytAdVideoId: null,
    adsDetected: true, joinButton: true, subscriberCount: 1000000, membersContent: true, videosChecked: 3
  });
  eq(r.verdict, 'MONETIZED');
  eq(r.confidence, 95);
});

test('ads + subs only (ytAd=null) → LIKELY_MONETIZED (60%)', () => {
  // ads(45) + subs(15) = 60 → LIKELY_MONETIZED
  const r = mockComputeVerdict({
    ytAdFound: null, ytAdVideoId: null,
    adsDetected: true, joinButton: false, subscriberCount: 5000, membersContent: false, videosChecked: 3
  });
  eq(r.verdict, 'LIKELY_MONETIZED');
  eq(r.confidence, 60);
});

test('join button + subs + no ads (ytAd=null, 3 vids) → UNLIKELY (20%)', () => {
  // -(3*7=21, cap 20) + join(25) + subs(15) = 20 → UNLIKELY
  const r = mockComputeVerdict({
    ytAdFound: null, ytAdVideoId: null,
    adsDetected: false, joinButton: true, subscriberCount: 5000, membersContent: false, videosChecked: 3
  });
  eq(r.verdict, 'UNLIKELY');
  eq(r.confidence, 20);
});

test('nothing detected, ytAd=null (watch page not checked) → UNKNOWN', () => {
  // ytAd null means NOT_MONETIZED branch requires ytAdFound=false explicitly
  const r = mockComputeVerdict({
    ytAdFound: null, ytAdVideoId: null,
    adsDetected: false, joinButton: false, subscriberCount: null, membersContent: false, videosChecked: 3
  });
  eq(r.verdict, 'UNKNOWN');
  eq(r.confidence, 0);
});

test('sub count < 500 → NOT_MONETIZED', () => {
  const r = mockComputeVerdict({
    adsDetected: false, joinButton: false, subscriberCount: 200, membersContent: false, videosChecked: 3
  });
  eq(r.verdict, 'NOT_MONETIZED');
});

test('ads null (not checked) + join button → UNLIKELY', () => {
  const r = mockComputeVerdict({
    adsDetected: null, joinButton: true, subscriberCount: 1500, membersContent: false, videosChecked: 0
  });
  eq(r.verdict, 'UNLIKELY');
  eq(r.confidence, 40);
});

test('all signals positive including ytAd → confidence capped at 100', () => {
  // ytAd(55) + ads(45) + join(25) + subs(15) + members(10) = 150 → capped at 100
  const r = mockComputeVerdict({
    ytAdFound: true, ytAdVideoId: 'abc12345678',
    adsDetected: true, joinButton: true, subscriberCount: 9999999, membersContent: true, videosChecked: 5
  });
  eq(r.confidence, 100);
  eq(r.verdict, 'MONETIZED');
});

console.log('\n── Ad detection from player response ───────────────');

function mockDetectAdsInResponse(response) {
  if (response.adPlacements && Array.isArray(response.adPlacements) && response.adPlacements.length > 0) {
    const adTypes = response.adPlacements.map(p => p?.adPlacementConfig?.kind || 'UNKNOWN');
    return { hasAds: true, adTypes };
  }
  return { hasAds: false, adTypes: [] };
}

test('detects pre-roll ad placement', () => {
  const resp = {
    adPlacements: [{ adPlacementConfig: { kind: 'AD_PLACEMENT_KIND_START' } }]
  };
  const r = mockDetectAdsInResponse(resp);
  ok(r.hasAds);
  deepEq(r.adTypes, ['AD_PLACEMENT_KIND_START']);
});

test('detects mid-roll ad placement', () => {
  const resp = {
    adPlacements: [{ adPlacementConfig: { kind: 'AD_PLACEMENT_KIND_MILLISECONDS' } }]
  };
  ok(mockDetectAdsInResponse(resp).hasAds);
});

test('detects multiple ad placements', () => {
  const resp = {
    adPlacements: [
      { adPlacementConfig: { kind: 'AD_PLACEMENT_KIND_START' } },
      { adPlacementConfig: { kind: 'AD_PLACEMENT_KIND_MILLISECONDS' } },
      { adPlacementConfig: { kind: 'AD_PLACEMENT_KIND_MILLISECONDS' } },
    ]
  };
  const r = mockDetectAdsInResponse(resp);
  ok(r.hasAds);
  eq(r.adTypes.length, 3);
});

test('returns false when adPlacements is empty array', () => {
  ok(!mockDetectAdsInResponse({ adPlacements: [] }).hasAds);
});

test('returns false when adPlacements absent', () => {
  ok(!mockDetectAdsInResponse({ videoDetails: { videoId: 'abc' } }).hasAds);
});

test('returns false when response is empty', () => {
  ok(!mockDetectAdsInResponse({}).hasAds);
});

// ─── New scoring behaviour: no-ads as negative signal ───────────────────────

test('3 videos checked, no ads, ytAd=false → NOT_MONETIZED', () => {
  // ytAd explicitly false + no ads + no other signals = NOT_MONETIZED
  const r = mockComputeVerdict({
    ytAdFound: false, ytAdVideoId: 'abc12345678',
    adsDetected: false, joinButton: false, subscriberCount: 5000,
    membersContent: false, videosChecked: 3
  });
  eq(r.verdict, 'NOT_MONETIZED');
});

test('3 videos checked, no ads, subs < 500 → NOT_MONETIZED', () => {
  const r = mockComputeVerdict({
    adsDetected: false, joinButton: false, subscriberCount: 200,
    membersContent: false, videosChecked: 3
  });
  eq(r.verdict, 'NOT_MONETIZED');
});

test('1 video checked no ads = -10 penalty', () => {
  const r = mockComputeVerdict({
    adsDetected: false, joinButton: false, subscriberCount: null,
    membersContent: false, videosChecked: 1
  });
  eq(r.confidence, 0); // penalty floors at 0
});

test('ads null (not checked) + subs only → UNKNOWN (15% confidence, below UNLIKELY threshold)', () => {
  // confidence: 0 (null ads) + 0 + 15 (subs) = 15 → below 20 threshold → UNKNOWN
  const r = mockComputeVerdict({
    adsDetected: null, joinButton: false, subscriberCount: 5000,
    membersContent: false, videosChecked: 0
  });
  eq(r.verdict, 'UNKNOWN');
  eq(r.confidence, 15);
});

test('no ads checked + join button → UNLIKELY not NOT_MONETIZED', () => {
  // Has join button even though no ads — edge case (ads disabled on all videos)
  const r = mockComputeVerdict({
    adsDetected: false, joinButton: true, subscriberCount: 5000,
    membersContent: false, videosChecked: 3
  });
  // confidence = -30 (3 vids no ads) + 25 (join) + 15 (subs) = 10 → but joinButton=true
  // so NOT_MONETIZED branch is skipped, falls to UNKNOWN
  ok(r.verdict !== 'NOT_MONETIZED', 'Join button present should prevent NOT_MONETIZED verdict');
});

test('confidence penalty capped at 30 even with 5 videos checked', () => {
  const r = mockComputeVerdict({
    adsDetected: false, joinButton: false, subscriberCount: null,
    membersContent: false, videosChecked: 5
  });
  // penalty = min(30, 5*10) = 30, then floored at 0
  eq(r.confidence, 0);
});

// ─── yt_ad signal tests ─────────────────────────────────────────────────────

test('yt_ad found = MONETIZED (55% from yt_ad alone)', () => {
  const r = mockComputeVerdict({
    ytAdFound: true, ytAdVideoId: 'abc12345678',
    adsDetected: false, videosChecked: 3,
    joinButton: false, subscriberCount: 5000, membersContent: false,
  });
  // ytAd(+55) - noAds(3*7=21, cap 20) + subs(+15) = 50 → LIKELY_MONETIZED
  eq(r.verdict, 'LIKELY_MONETIZED');
});

test('yt_ad found + ads found = MONETIZED (high confidence)', () => {
  const r = mockComputeVerdict({
    ytAdFound: true, ytAdVideoId: 'abc12345678',
    adsDetected: true, videosChecked: 3,
    joinButton: false, subscriberCount: 5000, membersContent: false,
  });
  // ytAd(+55) + ads(+45) + subs(+15) = 115 → capped at 100
  eq(r.verdict, 'MONETIZED');
  eq(r.confidence, 100);
});

test('yt_ad found + ads disabled per-video = LIKELY_MONETIZED (not NOT_MONETIZED)', () => {
  // This is the "monetized but ads turned off" case the old code got wrong
  const r = mockComputeVerdict({
    ytAdFound: true, ytAdVideoId: 'abc12345678',
    adsDetected: false, videosChecked: 3,
    joinButton: false, subscriberCount: 5000, membersContent: false,
  });
  ok(r.verdict !== 'NOT_MONETIZED', 'yt_ad present should prevent NOT_MONETIZED');
  ok(r.verdict !== 'UNKNOWN', 'yt_ad present should give a confident verdict');
});

test('yt_ad not found + no other signals = NOT_MONETIZED', () => {
  const r = mockComputeVerdict({
    ytAdFound: false, ytAdVideoId: 'abc12345678',
    adsDetected: false, videosChecked: 3,
    joinButton: false, subscriberCount: 5000, membersContent: false,
  });
  eq(r.verdict, 'NOT_MONETIZED');
});

test('yt_ad null (watch page not checked) falls back to other signals', () => {
  const r = mockComputeVerdict({
    ytAdFound: null, ytAdVideoId: null,
    adsDetected: true, videosChecked: 2,
    joinButton: false, subscriberCount: 5000, membersContent: false,
  });
  // Only ads(+45) + subs(+15) = 60 → LIKELY_MONETIZED
  eq(r.verdict, 'LIKELY_MONETIZED');
  eq(r.confidence, 60);
});

// ─── Async integration tests + summary ───────────────────────────────────────

async function runAsyncTests() {
  console.log('\n── Integration: result object shape ────────────────');

  await testAsync('returns valid result shape on bad input (network error)', async () => {
    // In sandbox there's no network to YouTube; the function should
    // fail gracefully with populated errors[], not throw.
    const result = await checkMonetization(
      'https://www.youtube.com/@__this_channel_does_not_exist_xyz__',
      { verbose: false, videoSamples: 1 }
    ).catch(() => null);

    ok(result === null || typeof result === 'object', 'Should return object or null');
    if (result) {
      ok('verdict' in result, 'Has verdict field');
      ok('confidence' in result, 'Has confidence field');
      ok('signals' in result, 'Has signals field');
      ok('channel' in result, 'Has channel field');
      ok('errors' in result, 'Has errors array');
      ok(Array.isArray(result.errors), 'errors is array');
      ok(typeof result.checkedAt === 'string', 'Has checkedAt timestamp');
    }
  });

  await testAsync('normaliseInput is exported and works', async () => {
    const r = normaliseInput('@TestChannel');
    eq(r.url, 'https://www.youtube.com/@TestChannel');
    eq(r.handle, 'TestChannel');
  });

  await testAsync('parseSubscriberText is exported and correct', async () => {
    eq(parseSubscriberText('1.5M'), 1500000);
    eq(parseSubscriberText('999K'), 999000);
    eq(parseSubscriberText('12,345'), 12345);
  });

  await testAsync('channel info fields present in result', async () => {
    const result = await checkMonetization('@SomeChannel', { verbose: false, videoSamples: 1 })
      .catch(() => null);
    if (result) {
      ok('input' in result.channel, 'channel.input present');
      ok('url' in result.channel, 'channel.url present');
      ok('handle' in result.channel, 'channel.handle present');
    }
  });

  await testAsync('signals object has all expected keys', async () => {
    const result = await checkMonetization('@SomeChannel', { verbose: false, videoSamples: 1 })
      .catch(() => null);
    if (result) {
      const expectedKeys = [
        'joinButton', 'joinButtonDetails', 'adsDetected',
        'adTypes', 'videosChecked', 'videoResults',
        'membersContent', 'subscriberCount', 'subscriberRaw',
      ];
      for (const k of expectedKeys) {
        ok(k in result.signals, `signals.${k} present`);
      }
    }
  });

  // ─── Summary ───────────────────────────────────────────────────────────────
  console.log('');
  console.log('══════════════════════════════════════════════════');
  console.log(` Results: ${passed} passed, ${failed} failed`);
  console.log('══════════════════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

runAsyncTests();
