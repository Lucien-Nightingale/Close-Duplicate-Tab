// =====================
// Close Duplicate Tabs - MV3 service worker (optimized)
// =====================
'use strict';

var stateChanged = true;
var tabUrl = Object.create(null);

// Exposed via runtime message (for compatibility / debugging)
var urlList = Object.create(null); // url => [tabs...]
var domains = [];                 // [{key, url}] unique per domain
var dupUrls = [];                 // flat list of duplicate tabs (candidate set)

// Legacy / reserved
var autoClose = false;

// Options
var includeBlankPages = false; // default: false (skip about:blank, chrome://newtab, ...)
var windowScope = 'current';   // 'current' | 'all'

// When enabled, pinned tabs are protected and will never be closed (overrides whitelist).
var protectPinnedTabs = false;

// When enabled, tab groups are treated as separate buckets (overrides whitelist).
var respectTabGroups = false;

// Suspended-tab handling (optional).
// If enabled and a tab URL looks like a suspended-page wrapper (chrome-extension://<id>/...#...&uri=<original>),
// we will treat it as the original URL for de-duplication and rule matching.
var suspendedUrlEnabled = false;

// When a duplicate set contains both suspended and non-suspended tabs (with the same comparable URL),
// this controls which one to prefer closing when candidates are otherwise equal.
//  - 'default': no preference (pinned > active > index)
//  - 'closeSuspended': prefer closing suspended tabs (i.e., keep non-suspended when possible)
//  - 'closeNormal': prefer closing non-suspended tabs (i.e., keep suspended when possible)
// NOTE: This is only meaningful when suspendedUrlEnabled is true.
var suspendedCloseMode = 'default';

// User-specified list of extension IDs that generate suspended-page wrapper URLs (one per line).
var suspenderExtensionIdSet = Object.create(null);

// Auto-close duplicates after N seconds (optional).
var autoCloseEnabled = false;
var autoCloseSeconds = 0;
var autoCloseTimer = null;
var autoCloseContextKey = '';

// Badge color customization (optional).
// Two themes are supported:
// - Duplicate-count theme (shown when the badge is displaying duplicate count)
// - Tab-count theme (shown when the badge is displaying tab count)
//
// Defaults (when custom colors are disabled):
// - Duplicate count: orange background + black text
// - Tab count: black background + white text
var badgeColorsEnabled = false;
var badgeDupBgColor = [255, 165, 0, 255];
var badgeDupTextColor = [0, 0, 0, 255];

// Legacy (v4.1.x): a single 'no-duplicates' theme. Kept for migration.
var badgeNoneBgColor = [158, 158, 158, 255];
var badgeNoneTextColor = [255, 255, 255, 255];

// New: explicit tab-count theme
var badgeTabBgColor = [0, 0, 0, 255];
var badgeTabTextColor = [255, 255, 255, 255];

// Badge text behavior (optional).
// - badgeShowDuplicateCount: show how many tabs would be closed (based on the current rules).
// - badgeShowTabCount: show total tab count when there are no duplicates, or always if duplicate count is hidden.
// - badgeTabCountScope: tab-count source ('current' focused window, or 'all' windows).
var badgeShowDuplicateCount = true;
var badgeShowTabCount = true;
var badgeTabCountScope = 'current'; // 'current' | 'all'

// Bump when config changes so timers can be invalidated.
var configRev = 0;

// When de-duping across ALL windows, protect a URL that appears exactly once in the focused window.
// (If the focused window has 2+ copies of the same URL, normal de-dup rules apply.)
var protectUniqueCurrentWindow = true;

// Track focus so the badge and "protect focused window" logic updates immediately on window switch.
var lastFocusedWindowId = null;

// Blacklists (patterns)
// Each line can be either:
//   - URL fragment (literal, case-insensitive, matched via substring)
//   - Regex (matched first) using:
//       re:<pattern>  OR  regex:<pattern>  OR  /pattern/flags
// Notes:
//   - Regex matching is performed before URL-fragment matching.
//   - We always force case-insensitive matching for regex (adds "i").
//   - Global/sticky flags (g/y) are ignored to avoid stateful RegExp.test() behavior.
var blacklistSameWindowRules = { re: [], url: [] };
var blacklistCrossWindowRules = { re: [], url: [] };

// Whitelist override (patterns)
var whitelistEnabled = false;
var whitelistRules = { re: [], url: [] };

// Content-equivalence (domain-scoped URL canonicalization)
//
// When enabled (and whitelist mode is OFF), certain domains can be treated as having
// multiple URLs that represent the same underlying content (e.g., YouTube watch URLs
// with different tracking parameters or youtu.be short links).
//
// IMPORTANT POLICY:
// - Content-equivalence can be used in both blacklist and whitelist mode.
// - Content-equivalence can be applied in both blacklist and whitelist mode.
var contentEqEnabled = false;
var contentEqDisableInWhitelist = true;
var contentEqUseManualRules = true;
var contentEqUseAutoRules = true;

// Compiled rules (kept in-memory for fast matching)
var contentEqManualRules = [];
var contentEqAutoRules = [];

var configLoaded = false;

function toLower(s) { return (s || '').toLowerCase(); }

function normalizeRegexFlags(flags) {
  flags = (flags || '').replace(/[^gimsuyd]/g, '');
  flags = flags.replace(/[gy]/g, '');
  if (flags.indexOf('i') === -1) flags += 'i';
  return flags;
}

function parseHexColorToRgba(input, fallback) {
  // Accept: #RGB, #RGBA, #RRGGBB, #RRGGBBAA (or without leading #).
  var s = String(input || '').trim();
  if (!s) return Array.isArray(fallback) ? fallback : [255, 165, 0, 255];
  if (s[0] === '#') s = s.slice(1);
  if (!/^[0-9a-fA-F]+$/.test(s)) return Array.isArray(fallback) ? fallback : [255, 165, 0, 255];
  if (s.length === 3 || s.length === 4) {
    var out = '';
    for (var i = 0; i < s.length; i++) out += s[i] + s[i];
    s = out;
  }
  if (!(s.length === 6 || s.length === 8)) return Array.isArray(fallback) ? fallback : [255, 165, 0, 255];
  var r = parseInt(s.slice(0, 2), 16);
  var g = parseInt(s.slice(2, 4), 16);
  var b = parseInt(s.slice(4, 6), 16);
  var a = (s.length === 8) ? parseInt(s.slice(6, 8), 16) : 255;
  if (!(r >= 0 && r <= 255 && g >= 0 && g <= 255 && b >= 0 && b <= 255 && a >= 0 && a <= 255)) {
    return Array.isArray(fallback) ? fallback : [255, 165, 0, 255];
  }
  return [r, g, b, a];
}

function parseRegexRule(v) {
  // v is already trimmed, and indicates a regex rule.
  if (!v) return null;

  var lower = toLower(v);
  if (lower.indexOf('re:') === 0) {
    var pat1 = v.slice(3).trim();
    if (!pat1) return null;
    try { return new RegExp(pat1, 'i'); } catch (e1) { return null; }
  }
  if (lower.indexOf('regex:') === 0) {
    var pat2 = v.slice(6).trim();
    if (!pat2) return null;
    try { return new RegExp(pat2, 'i'); } catch (e2) { return null; }
  }

  // /pattern/flags
  if (v[0] === '/' && v.lastIndexOf('/') > 0) {
    var last = v.lastIndexOf('/');
    var pat = v.slice(1, last);
    var flags = normalizeRegexFlags(v.slice(last + 1) || '');
    try { return new RegExp(pat, flags); } catch (e3) { return null; }
  }

  return null;
}

function compileRuleList(list) {
  var out = { re: [], url: [] };
  if (!Array.isArray(list)) return out;
  var seen = Object.create(null);

  for (var i = 0; i < list.length; i++) {
    var v = (list[i] || '').trim();
    if (!v) continue;
    var key = toLower(v);
    if (seen[key]) continue;
    seen[key] = true;

    // Regex rules are explicit: re:/regex: or /pattern/flags
    var lower = toLower(v);
    var isRegex = (lower.indexOf('re:') === 0) || (lower.indexOf('regex:') === 0) || (v[0] === '/' && v.lastIndexOf('/') > 0);

    if (isRegex) {
      var re = parseRegexRule(v);
      if (re) out.re.push(re);
      continue;
    }

    // URL fragment (literal)
    out.url.push(key);
  }

  return out;
}

function matchRules(url, urlLower, rules) {
  if (!url) return false;
  if (!rules) return false;
  if (!urlLower) urlLower = toLower(url);

  // 1) Regex rules first
  if (rules.re && rules.re.length) {
    for (var i = 0; i < rules.re.length; i++) {
      var re = rules.re[i];
      if (!re) continue;
      try {
        if (re.test(url)) return true;
      } catch (e) {
        // ignore runtime errors
      }
    }
  }

  // 2) URL fragment rules (literal substring)
  if (rules.url && rules.url.length) {
    for (var j = 0; j < rules.url.length; j++) {
      var frag = rules.url[j];
      if (!frag) continue;
      if (urlLower.indexOf(frag) !== -1) return true;
    }
  }

  return false;
}

function isBlankPageLower(urlLower) {
  if (!urlLower) return true;
  if (urlLower === 'about:blank') return true;
  if (urlLower.indexOf('chrome://newtab') === 0) return true;
  if (urlLower.indexOf('chrome://new-tab-page') === 0) return true;
  if (urlLower.indexOf('edge://newtab') === 0) return true;
  return false;
}

function shouldProcessUrl(url, urlLower) {
  if (!urlLower) return false;
  if (!includeBlankPages && isBlankPageLower(urlLower)) return false;
  if (whitelistEnabled && !matchRules(url, urlLower, whitelistRules)) return false;
  return true;
}

// =====================
// Suspended-page URL extraction
// =====================
function compileExtensionIdSet(list) {
  var set = Object.create(null);
  if (!Array.isArray(list)) return set;
  for (var i = 0; i < list.length; i++) {
    var v = (list[i] || '').trim();
    if (!v) continue;
    set[toLower(v)] = true;
  }
  return set;
}

function parseSuspendedOriginalUrl(tabUrl) {
  if (!suspendedUrlEnabled) return null;
  if (!tabUrl) return null;
  if (tabUrl.indexOf('chrome-extension://') !== 0) return null;

  // Extract extension id
  var rest = tabUrl.slice('chrome-extension://'.length);
  var slash = rest.indexOf('/');
  if (slash <= 0) return null;
  var extId = toLower(rest.slice(0, slash));
  if (!suspenderExtensionIdSet || !suspenderExtensionIdSet[extId]) return null;

  // Suspender wrappers usually store the original URL in the hash or query part.
  var payloads = [];
  var hashPos = tabUrl.indexOf('#');
  var qPos = tabUrl.indexOf('?');
  if (qPos >= 0) {
    var end = (hashPos >= 0) ? hashPos : tabUrl.length;
    payloads.push(tabUrl.slice(qPos + 1, end) || '');
  }
  if (hashPos >= 0) payloads.push(tabUrl.slice(hashPos + 1) || '');

  for (var px = 0; px < payloads.length; px++) {
    var frag = payloads[px];
    if (!frag) continue;

    // Treat payload as a query-string-like blob: k=v&k2=v2...
    var parts = frag.split('&');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (!p) continue;
      var eq = p.indexOf('=');
      if (eq <= 0) continue;
      var k = toLower(p.slice(0, eq));
      if (k !== 'uri' && k !== 'url' && k !== 'originalurl') continue;
      var raw = p.slice(eq + 1);
      if (!raw) continue;
      try {
        var decoded = decodeURIComponent(raw);
        if (decoded && (decoded.indexOf('http://') === 0 || decoded.indexOf('https://') === 0)) return decoded;
      } catch (e) {
        // ignore decode errors
      }
    }
  }

  return null;
}

function getComparableUrlInfo(tabUrl, cache) {
  if (!tabUrl) return { url: tabUrl, isSuspended: false };
  if (cache && cache[tabUrl]) return cache[tabUrl];

  var original = parseSuspendedOriginalUrl(tabUrl);
  var info = original ? { url: original, isSuspended: true } : { url: tabUrl, isSuspended: false };

  if (cache) cache[tabUrl] = info;
  return info;
}


// =====================
// Content-equivalence (domain-scoped URL canonicalization)
// =====================
function safeParseHttpUrl(url) {
  try {
    var u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return {
      host: u.host,
      hostLower: (u.host || '').toLowerCase(),
      pathname: u.pathname || '/',
      searchParams: u.searchParams,
      href: u.href
    };
  } catch (e) {
    return null;
  }
}

function normalizeExtractorFlags(flags) {
  // For extractors, we remove g/y to avoid stateful RegExp.test() behavior.
  // We do NOT force case-insensitive matching here because some IDs are case-sensitive.
  flags = (flags || '').replace(/[^gimsuyd]/g, '');
  flags = flags.replace(/[gy]/g, '');
  return flags;
}

function isExplicitRegexLine(v) {
  if (!v) return false;
  var s = String(v).trim();
  if (!s) return false;
  var lower = s.toLowerCase();
  if (lower.indexOf('re:') === 0) return true;
  if (lower.indexOf('regex:') === 0) return true;
  return (s[0] === '/' && s.lastIndexOf('/') > 0);
}

function parseExtractorRegexRule(v) {
  v = (v || '').trim();
  if (!v) return null;
  var lower = v.toLowerCase();

  // re:<pattern>
  if (lower.indexOf('re:') === 0) {
    var p1 = v.slice(3).trim();
    if (!p1) return null;
    try { return new RegExp(p1); } catch (e1) { return null; }
  }

  // regex:<pattern>
  if (lower.indexOf('regex:') === 0) {
    var p2 = v.slice(6).trim();
    if (!p2) return null;
    try { return new RegExp(p2); } catch (e2) { return null; }
  }

  // /pattern/flags
  if (v[0] === '/' && v.lastIndexOf('/') > 0) {
    var last = v.lastIndexOf('/');
    var pat = v.slice(1, last);
    var flags = normalizeExtractorFlags(v.slice(last + 1) || '');
    try { return new RegExp(pat, flags); } catch (e3) { return null; }
  }

  return null;
}

function parseHostMatcher(hostSpec) {
  hostSpec = (hostSpec || '').trim();
  if (!hostSpec) return null;

  // Allow regex host matchers (same syntax as other rule lists).
  if (isExplicitRegexLine(hostSpec)) {
    var re = parseRegexRule(hostSpec);
    if (!re) return null;
    return { kind: 're', re: re, raw: hostSpec };
  }

  // Normalize possible accidental schemes/paths.
  var s = hostSpec.replace(/^https?:\/\//i, '');
  s = s.split('/')[0];
  s = (s || '').trim().toLowerCase();
  if (!s) return null;
  return { kind: 'suffix', suffix: s, raw: hostSpec };
}

function normalizeEqToken(part, opts) {
  // Conservative normalization for extracted equivalence tokens:
  // - If the match appears to come from a query-string value (e.g. ?q=...),
  //   treat '+' as a space (application/x-www-form-urlencoded semantics),
  //   so "hello+world" and "hello%20world" become the same key.
  // - decodeURIComponent (best-effort)
  // - language tags like zh-TW / zh_TW -> zh_TW
  // - otherwise keep as-is (important: some IDs are case-sensitive)
  var s = String(part || '').trim();
  if (!s) return '';
  var plusAsSpace = !!(opts && opts.plusAsSpace);
  if (plusAsSpace && s.indexOf('+') >= 0) {
    // Only literal '+' is treated as space. A literal plus should normally be encoded as %2B.
    s = s.replace(/\+/g, ' ');
  }
  try { s = decodeURIComponent(s); } catch (e) {}
  // Normalize common locale tags
  if (/^[A-Za-z]{2,3}[-_][A-Za-z]{2,4}$/.test(s)) {
    var p = s.split(/[-_]/);
    if (p.length >= 2) {
      s = String(p[0] || '').toLowerCase() + '_' + String(p[1] || '').toUpperCase();
    }
  }
  return s;
}

function buildCanonicalUrl(target, originalUrl, tokenNorm) {
  if (!target) return null;
  var t = String(target || '').trim();
  if (!t) return null;

  // Substitute $1 with the (normalized) token, URL-encoded.
  if (typeof tokenNorm === 'string' && tokenNorm.length) {
    try {
      t = t.replace(/\$1/g, encodeURIComponent(tokenNorm));
    } catch (e1) {
      // ignore
    }
  }

  try {
    // Full URL
    if (t.indexOf('://') >= 0) return t;

    var base = new URL(originalUrl);

    // Origin-relative
    if (t[0] === '/' || t[0] === '?' || t[0] === '#') {
      return base.origin + t;
    }

    // Host+path without scheme: treat as same scheme.
    if (t.indexOf('/') >= 0 || t.indexOf('?') >= 0 || t.indexOf('#') >= 0) {
      return base.protocol + '//' + t;
    }

    // Host only: keep path/search/hash as-is, but swap hostname.
    base.hostname = t;
    return base.toString();
  } catch (e2) {
    return null;
  }
}

function parseContentEqRuleLine(line) {
  line = (line || '').trim();
  if (!line) return null;
  if (line[0] === '#') return null;
  if (line.indexOf('//') === 0) return null;

  var idx = line.indexOf('=>');
  if (idx < 0) return null;

  var hostSpec = (line.slice(0, idx) || '').trim();
  var rest = (line.slice(idx + 2) || '').trim();
  if (!hostSpec || !rest) return null;

  // Optional canonical target: last "=>" in rest, only if the tail is NOT an explicit regex.
  var canonicalTarget = '';
  var extractorPart = rest;

  var last = rest.lastIndexOf('=>');
  if (last >= 0) {
    var tail = (rest.slice(last + 2) || '').trim();
    var before = (rest.slice(0, last) || '').trim();
    if (tail && before && !isExplicitRegexLine(tail)) {
      canonicalTarget = tail;
      extractorPart = before;
    }
  }

  // Multiple equivalent extractors can be separated by "<=>" (preferred) or "=>".
  var extractorSpecs = [];
  if (extractorPart.indexOf('<=>') >= 0) {
    extractorSpecs = extractorPart.split('<=>');
  } else if (extractorPart.indexOf('=>') >= 0) {
    extractorSpecs = extractorPart.split('=>');
  } else {
    extractorSpecs = [extractorPart];
  }

  var cleaned = [];
  for (var i = 0; i < extractorSpecs.length; i++) {
    var e = (extractorSpecs[i] || '').trim();
    if (e) cleaned.push(e);
  }
  if (!cleaned.length) return null;

  return { hostSpec: hostSpec, extractorSpecs: cleaned, canonicalTarget: canonicalTarget };
}


function splitHostSpecList(hostSpec) {
  // Support multi-host rules using a comma-separated host list:
  //   youtube.com, youtu.be => re:...
  //
  // If you need complex host matching, prefer a single explicit regex host spec (re:...).
  var raw = String(hostSpec || '').trim();
  if (!raw) return [];
  return raw.split(',').map(function (s) { return (s || '').trim(); }).filter(function (s) { return !!s; });
}

function compileContentEquivalenceRules(lines) {
  // Accept either an array of lines or a single multiline string.
  if (!Array.isArray(lines)) {
    lines = String(lines || '').split('\n');
  }

  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var raw = (lines[i] || '').trim();
    var parsed = parseContentEqRuleLine(raw);
    if (!parsed) continue;

    var hostSpec = parsed.hostSpec;
    var extractorSpecs = parsed.extractorSpecs;
    var canonicalTarget = parsed.canonicalTarget || '';

    var hostSpecs = splitHostSpecList(hostSpec);
    var hostMatchers = [];
    for (var h = 0; h < hostSpecs.length; h++) {
      var hm = parseHostMatcher(hostSpecs[h]);
      if (hm) hostMatchers.push(hm);
    }
    if (!hostMatchers.length) continue;

    var extractors = [];
    for (var j = 0; j < extractorSpecs.length; j++) {
      var ex = parseExtractorRegexRule(extractorSpecs[j]);
      if (ex) extractors.push(ex);
    }
    if (!extractors.length) continue;

    // Domain-scoped canonicalization:
    // - Single host keeps the legacy scope key: h:<suffix> or h:<rawRegex>
    // - Multi-host rule shares a single scope key across ALL listed hosts.
    var scopeKey = '';
    if (hostMatchers.length === 1) {
      var host0 = hostMatchers[0];
      scopeKey = (host0.kind === 'suffix') ? ('h:' + host0.suffix) : ('h:' + host0.raw);
    } else {
      var parts = [];
      for (var k = 0; k < hostMatchers.length; k++) {
        var hk = hostMatchers[k];
        if (!hk) continue;
        if (hk.kind === 'suffix') parts.push('s:' + hk.suffix);
        else parts.push('r:' + String(hk.raw || '').trim());
      }
      parts.sort();
      scopeKey = 'hlist:' + parts.join(',');
    }

    out.push({
      hostMatchers: hostMatchers,
      scopeKey: scopeKey,
      extractorRes: extractors,
      canonicalTarget: canonicalTarget,
      raw: raw
    });
  }
  return out;
}

function hostMatches(rule, hostLower, host) {
  if (!rule || !rule.hostMatchers || !rule.hostMatchers.length) return false;

  for (var i = 0; i < rule.hostMatchers.length; i++) {
    var hm = rule.hostMatchers[i];
    if (!hm) continue;

    if (hm.kind === 'suffix') {
      var s = hm.suffix;
      if (!s) continue;
      if (hostLower === s || hostLower.endsWith('.' + s)) return true;
    } else if (hm.kind === 're') {
      if (hm.re && hm.re.test(host)) return true;
    }
  }
  return false;
}

function extractEquivalenceInfoFromRules(url, uObj, rules) {
  if (!rules || !rules.length || !uObj) return null;
  var hostLower = uObj.hostLower;
  var host = uObj.host;

  for (var i = 0; i < rules.length; i++) {
    var r = rules[i];
    if (!hostMatches(r, hostLower, host)) continue;

    var exList = r.extractorRes || [];
    for (var j = 0; j < exList.length; j++) {
      var ex = exList[j];
      if (!ex) continue;

      var m = ex.exec(url);
      if (!m) continue;

      var part = (m.length > 1 && m[1]) ? m[1] : m[0];
      if (!part) continue;

      var isQueryValue = !!(m && m[0] && m[0].indexOf('=') >= 0 && (m[0].indexOf('?') >= 0 || m[0].indexOf('&') >= 0));
      var tokenNorm = normalizeEqToken(part, { plusAsSpace: isQueryValue }) || part;
      var canon = buildCanonicalUrl(r.canonicalTarget, url, tokenNorm);

      return {
        scopeKey: r.scopeKey,
        token: tokenNorm,
        canonicalUrl: canon,
        raw: r.raw || ''
      };
    }
  }
  return null;
}

// Find the first canonical redirect produced by the rule list.
// IMPORTANT: A match that does NOT change the URL must NOT block later rules.
// This is required because some setups use a later rule to transform the URL
// ("def"), which then allows an earlier rule ("abc") to match on the next pass.
function findCanonicalRedirectFromRules(url, uObj, rules) {
  if (!rules || !rules.length || !uObj) return null;
  var hostLower = uObj.hostLower;
  var host = uObj.host;

  for (var i = 0; i < rules.length; i++) {
    var r = rules[i];
    if (!hostMatches(r, hostLower, host)) continue;
    if (!r.canonicalTarget) continue;

    var exList = r.extractorRes || [];
    for (var j = 0; j < exList.length; j++) {
      var ex = exList[j];
      if (!ex) continue;

      var m = ex.exec(url);
      if (!m) continue;

      var part = (m.length > 1 && m[1]) ? m[1] : m[0];
      if (!part) continue;

      var isQueryValue = !!(m && m[0] && m[0].indexOf('=') >= 0 && (m[0].indexOf('?') >= 0 || m[0].indexOf('&') >= 0));
      var tokenNorm = normalizeEqToken(part, { plusAsSpace: isQueryValue }) || part;
      var canon = buildCanonicalUrl(r.canonicalTarget, url, tokenNorm);

      if (canon && canon !== url) return canon;
      // If canon is null OR equals url, do not block: continue scanning.
    }
  }
  return null;
}


function getContentEquivalenceInfo(comparableUrl) {
  // Policy: equivalence is active whenever the feature is enabled.
  if (!contentEqEnabled) return null;
  if (whitelistEnabled && contentEqDisableInWhitelist) return null;

  // Optional canonicalization pass (fixpoint iteration):
  // If a rule provides a canonicalTarget, we can repeatedly "redirect" the comparableUrl
  // before extracting the final equivalence key.
  //
  // IMPORTANT: we iterate until the URL stops changing (or a small max-iteration limit),
  // because some rules only become applicable after another rule rewrites the URL.
  // This also means we must keep scanning for redirects even if an earlier rule matches
  // but does not redirect, so later redirect rules are not accidentally masked.
  var cur = comparableUrl;
  var transformed = false;
  var seen = Object.create(null);

  for (var iter = 0; iter < 10; iter++) {
    if (!cur) break;
    if (seen[cur]) break;
    seen[cur] = true;

    var u0 = safeParseHttpUrl(cur);
    if (!u0) break;

    var next = null;

    if (contentEqUseManualRules && contentEqManualRules && contentEqManualRules.length) {
      next = findCanonicalRedirectFromRules(cur, u0, contentEqManualRules);
    }

    if (!next && contentEqUseAutoRules && contentEqAutoRules && contentEqAutoRules.length) {
      next = findCanonicalRedirectFromRules(cur, u0, contentEqAutoRules);
    }

    if (next) {
      cur = next;
      transformed = true;
      continue;
    }
    break;
  }

  var uObj = safeParseHttpUrl(cur);
  if (!uObj) return null;

  var finalKey = null;
  var lastRuleInfo = null;

  // 1) Manual rules (user-defined) – highest priority
  if (contentEqUseManualRules && contentEqManualRules && contentEqManualRules.length) {
    var i1 = extractEquivalenceInfoFromRules(cur, uObj, contentEqManualRules);
    if (i1) {
      lastRuleInfo = i1;
      finalKey = 'manual|' + i1.scopeKey + '|' + i1.token;
    }
  }

  // 2) Auto-generated rules (domain-scoped)
  if (!finalKey && contentEqUseAutoRules && contentEqAutoRules && contentEqAutoRules.length) {
    var i2 = extractEquivalenceInfoFromRules(cur, uObj, contentEqAutoRules);
    if (i2) {
      lastRuleInfo = i2;
      finalKey = 'auto|' + i2.scopeKey + '|' + i2.token;
    }
  }

  if (!finalKey) return null;

  // "canonicalUrl" is only a preference signal: if present, we'll prefer keeping
  // the tab that already matches it.
  var canonicalUrl = null;
  if (transformed) {
    canonicalUrl = cur;
  } else if (lastRuleInfo && lastRuleInfo.canonicalUrl) {
    canonicalUrl = lastRuleInfo.canonicalUrl;
  }

  return { key: finalKey, canonicalUrl: canonicalUrl, effectiveUrl: cur };
}


function getDomain(url) {
  try {
    var host = new URL(url).host;
    var parts = host.split('.');
    if (parts.length <= 2) return host;
    return parts[parts.length - 2] + '.' + parts[parts.length - 1];
  } catch (e) {
    return '';
  }
}

// Prefer pinned > active > lowest index (stable)
function chooseKeeper(tabs) {
  var keeper = tabs[0];
  for (var i = 1; i < tabs.length; i++) {
    var t = tabs[i];
    if (!keeper) { keeper = t; continue; }

    if (!!t.pinned && !keeper.pinned) { keeper = t; continue; }
    if (!!t.pinned === !!keeper.pinned) {
      if (!!t.active && !keeper.active) { keeper = t; continue; }
      if (!!t.active === !!keeper.active) {
        // Canonical-url preference (optional): if a rule defines a canonicalTarget,
        // prefer keeping the tab that already matches that canonical URL.
        var tCanon = !!(t && t._cdtEqCanonicalUrl && t._cdtComparableUrl === t._cdtEqCanonicalUrl);
        var kCanon = !!(keeper && keeper._cdtEqCanonicalUrl && keeper._cdtComparableUrl === keeper._cdtEqCanonicalUrl);
        if (tCanon && !kCanon) { keeper = t; continue; }
        if (!tCanon && kCanon) { continue; }
        // Suspended-tab tie-breaker (optional): only applied when pinned+active are equal.
        if (suspendedCloseMode === 'closeSuspended') {
          var tSusp = !!t._cdtIsSuspended;
          var kSusp = !!keeper._cdtIsSuspended;
          // Prefer keeping a non-suspended tab.
          if (!tSusp && kSusp) { keeper = t; continue; }
        } else if (suspendedCloseMode === 'closeNormal') {
          var tSusp2 = !!t._cdtIsSuspended;
          var kSusp2 = !!keeper._cdtIsSuspended;
          // Prefer keeping a suspended tab.
          if (tSusp2 && !kSusp2) { keeper = t; continue; }
        }
        // index is per-window; still a reasonable tie-breaker
        if (typeof t.index === 'number' && typeof keeper.index === 'number' && t.index < keeper.index) {
          keeper = t;
        }
      }
    }
  }
  return keeper;
}

function groupTabsByWindow(tabs) {
  var byWin = Object.create(null);
  for (var i = 0; i < tabs.length; i++) {
    var w = String(tabs[i].windowId);
    (byWin[w] || (byWin[w] = [])).push(tabs[i]);
  }
  return byWin;
}

// =====================
// Config
// =====================
// Local backup key (storage.local). This protects user customization from
// schema changes / sync issues / quota edge-cases.
var SETTINGS_BACKUP_KEY = 'cdt_settings_backup_v1';

function pickConfigSnapshot(items, keys) {
  var out = Object.create(null);
  if (!items || !keys || !keys.length) return out;
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (k in items) out[k] = items[k];
  }
  return out;
}

function mergeMissingFromBackup(syncItems, backupData, keys) {
  if (!backupData || typeof backupData !== 'object') return syncItems || {};
  var out = Object.create(null);
  syncItems = syncItems || {};
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (k in syncItems) out[k] = syncItems[k];
    else if (k in backupData) out[k] = backupData[k];
  }
  return out;
}

function updateLocalBackupFromSyncChanges(changes) {
  if (!changes) return;
  // Lazy-merge into the existing backup, so we don't need to read all sync keys.
  try {
    chrome.storage.local.get([SETTINGS_BACKUP_KEY], function (li) {
      var cur = li && li[SETTINGS_BACKUP_KEY];
      var data = (cur && cur.data && typeof cur.data === 'object') ? cur.data : Object.create(null);
      for (var k in changes) {
        if (!Object.prototype.hasOwnProperty.call(changes, k)) continue;
        data[k] = changes[k] ? changes[k].newValue : undefined;
      }
      chrome.storage.local.set({
        [SETTINGS_BACKUP_KEY]: { v: 1, savedAt: Date.now(), data: data }
      });
    });
  } catch (e) {}
}

function applyConfigFromItems(items, callback) {
  items = items || {};

  autoClose = !!items.autoClose;

  autoCloseEnabled = ('autoCloseEnabled' in items) ? !!items.autoCloseEnabled : false;
  autoCloseSeconds = ('autoCloseSeconds' in items) ? (parseInt(items.autoCloseSeconds, 10) || 0) : 0;

  suspendedUrlEnabled = ('suspendedUrlEnabled' in items) ? !!items.suspendedUrlEnabled : false;
  // Migration: v4.1.0 used a boolean "preferCloseSuspendedTabs". v4.1.1 uses a 3-way string mode.
  suspendedCloseMode = ('suspendedCloseMode' in items) ? String(items.suspendedCloseMode || 'default') : '';
  if (!suspendedCloseMode) {
    suspendedCloseMode = ('preferCloseSuspendedTabs' in items && !!items.preferCloseSuspendedTabs) ? 'closeSuspended' : 'default';
  }
  if (suspendedCloseMode !== 'closeSuspended' && suspendedCloseMode !== 'closeNormal') suspendedCloseMode = 'default';
  suspenderExtensionIdSet = compileExtensionIdSet(items.suspenderExtensionIds);

  badgeColorsEnabled = ('badgeColorsEnabled' in items) ? !!items.badgeColorsEnabled : false;
  // Apply custom badge colors if enabled; invalid inputs fall back to defaults.
  // Defaults (custom colors disabled): dup=orange/bg + black/text, tab=black/bg + white/text
  badgeDupBgColor = parseHexColorToRgba(items.badgeDupBg, [255, 165, 0, 255]);
  badgeDupTextColor = parseHexColorToRgba(items.badgeDupText, [0, 0, 0, 255]);
  // Legacy 'no-duplicates' theme is kept for migration.
  badgeNoneBgColor = parseHexColorToRgba(items.badgeNoneBg, [158, 158, 158, 255]);
  badgeNoneTextColor = parseHexColorToRgba(items.badgeNoneText, [255, 255, 255, 255]);
  // New explicit tab-count theme (falls back to legacy 'no-duplicates' colors if present).
  var legacyTabBg = ('badgeNoneBg' in items) ? parseHexColorToRgba(items.badgeNoneBg, [0, 0, 0, 255]) : [0, 0, 0, 255];
  var legacyTabText = ('badgeNoneText' in items) ? parseHexColorToRgba(items.badgeNoneText, [255, 255, 255, 255]) : [255, 255, 255, 255];
  badgeTabBgColor = parseHexColorToRgba(items.badgeTabBg, legacyTabBg);
  badgeTabTextColor = parseHexColorToRgba(items.badgeTabText, legacyTabText);

  // Badge text behavior
  // Default policy:
  // - If auto-close is enabled, default to hiding the duplicate count.
  // - Always default to showing tab count so the "no duplicates" state is visible.
  badgeShowDuplicateCount = ('badgeShowDuplicateCount' in items) ? !!items.badgeShowDuplicateCount : !autoCloseEnabled;
  badgeShowTabCount = ('badgeShowTabCount' in items) ? !!items.badgeShowTabCount : true;
  badgeTabCountScope = (items.badgeTabCountScope === 'all') ? 'all' : 'current';

  includeBlankPages = !!items.includeBlankPages;
  windowScope = (items.windowScope === 'all') ? 'all' : 'current';

  protectPinnedTabs = ('protectPinnedTabs' in items) ? !!items.protectPinnedTabs : false;
  respectTabGroups = ('respectTabGroups' in items) ? !!items.respectTabGroups : false;

  // Default: true (protect focused window's unique URLs when closing across windows)
  protectUniqueCurrentWindow = ('protectUniqueCurrentWindow' in items) ? !!items.protectUniqueCurrentWindow : true;

  whitelistEnabled = !!items.whitelistEnabled;
  whitelistRules = compileRuleList(items.whitelistList);

  var legacy = Array.isArray(items.filterList) ? items.filterList : [];

  var sameKeyExists = ('blacklistSameWindow' in items);
  var crossKeyExists = ('blacklistCrossWindow' in items);

  var sameRaw = sameKeyExists ? items.blacklistSameWindow : (legacy.length ? legacy : ['yahoo.']);
  var crossRaw = crossKeyExists ? items.blacklistCrossWindow : (legacy.length ? legacy : ['yahoo.']);

  blacklistSameWindowRules = compileRuleList(sameRaw);
  blacklistCrossWindowRules = compileRuleList(crossRaw);

  // Content-equivalence (domain-scoped)
  contentEqEnabled = ('contentEqEnabled' in items) ? !!items.contentEqEnabled : false;
  contentEqDisableInWhitelist = ('contentEqDisableInWhitelist' in items) ? !!items.contentEqDisableInWhitelist : true;
  contentEqUseManualRules = ('contentEqUseManualRules' in items) ? !!items.contentEqUseManualRules : true;
  contentEqUseAutoRules = ('contentEqUseAutoRules' in items) ? !!items.contentEqUseAutoRules : true;
  contentEqManualRules = compileContentEquivalenceRules(items.contentEqManualRuleList);
  contentEqAutoRules = compileContentEquivalenceRules(items.contentEqAutoRuleList);

  configLoaded = true;
  configRev++;
  if (typeof callback === 'function') callback();
}

function loadConfigs(callback) {
  var CONFIG_KEYS = [
    'autoClose',
    'autoCloseEnabled',
    'autoCloseSeconds',
    'suspendedUrlEnabled',
    'suspendedCloseMode',
    'preferCloseSuspendedTabs',
    'suspenderExtensionIds',

    'badgeColorsEnabled',
    'badgeShowDuplicateCount',
    'badgeShowTabCount',
    'badgeTabCountScope',
    'badgeDupBg',
    'badgeDupText',
    'badgeNoneBg',
    'badgeNoneText',
    'badgeTabBg',
    'badgeTabText',
    'includeBlankPages',
    'windowScope',
    'protectPinnedTabs',
    'respectTabGroups',
    'protectUniqueCurrentWindow',
    'blacklistSameWindow',
    'blacklistCrossWindow',
    'whitelistEnabled',
    'whitelistList',

    'contentEqEnabled',
    'contentEqDisableInWhitelist',
    'contentEqUseManualRules',
    'contentEqUseAutoRules',
    'contentEqManualRuleList',
    'contentEqAutoRuleList',
    'filterList' // legacy (single blacklist)
  ];

  chrome.storage.sync.get(CONFIG_KEYS, function (syncItems) {
    // Merge with local backup to avoid losing personalization after upgrades.
    chrome.storage.local.get([SETTINGS_BACKUP_KEY], function (li) {
      var backup = li && li[SETTINGS_BACKUP_KEY];
      var backupData = (backup && backup.data && typeof backup.data === 'object') ? backup.data : null;

      var items = mergeMissingFromBackup(syncItems, backupData, CONFIG_KEYS);

      // Refresh backup snapshot (best-effort).
      try {
        chrome.storage.local.set({
          [SETTINGS_BACKUP_KEY]: { v: 1, savedAt: Date.now(), data: pickConfigSnapshot(items, CONFIG_KEYS) }
        });
      } catch (e0) {}

      // If sync is empty (e.g. after a migration / sync reset), best-effort restore from backup.
      if (backupData && (!syncItems || Object.keys(syncItems).length === 0)) {
        try { chrome.storage.sync.set(pickConfigSnapshot(backupData, CONFIG_KEYS)); } catch (e1) {}
      }

      // Continue with the normal parsing logic.
      applyConfigFromItems(items, callback);
    });
  });
}

chrome.storage.onChanged.addListener(function (changes, areaName) {
  if (areaName !== 'sync') return;

  // Maintain a resilient local backup of the user's settings.
  updateLocalBackupFromSyncChanges(changes);

  if (changes.autoClose) autoClose = !!changes.autoClose.newValue;

  if (changes.autoCloseEnabled) autoCloseEnabled = !!changes.autoCloseEnabled.newValue;
  if (changes.autoCloseSeconds) autoCloseSeconds = (parseInt(changes.autoCloseSeconds.newValue, 10) || 0);

  if (changes.suspendedUrlEnabled) suspendedUrlEnabled = !!changes.suspendedUrlEnabled.newValue;
  if (changes.suspendedCloseMode) {
    var mode = String(changes.suspendedCloseMode.newValue || 'default');
    suspendedCloseMode = (mode === 'closeSuspended' || mode === 'closeNormal') ? mode : 'default';
  }
  if (changes.suspenderExtensionIds) suspenderExtensionIdSet = compileExtensionIdSet(changes.suspenderExtensionIds.newValue);

  if (changes.badgeColorsEnabled) badgeColorsEnabled = !!changes.badgeColorsEnabled.newValue;
  if (changes.badgeShowDuplicateCount) badgeShowDuplicateCount = !!changes.badgeShowDuplicateCount.newValue;
  if (changes.badgeShowTabCount) badgeShowTabCount = !!changes.badgeShowTabCount.newValue;
  if (changes.badgeTabCountScope) badgeTabCountScope = (changes.badgeTabCountScope.newValue === 'all') ? 'all' : 'current';
  if (changes.badgeDupBg) badgeDupBgColor = parseHexColorToRgba(changes.badgeDupBg.newValue, badgeDupBgColor);
  if (changes.badgeDupText) badgeDupTextColor = parseHexColorToRgba(changes.badgeDupText.newValue, badgeDupTextColor);
  if (changes.badgeNoneBg) {
    badgeNoneBgColor = parseHexColorToRgba(changes.badgeNoneBg.newValue, badgeNoneBgColor);
    // v4.1.x used badgeNone* for the no-duplicates state. Until the UI is fully updated,
    // keep tab theme in sync when badgeTab* isn't explicitly set.
    if (!changes.badgeTabBg) badgeTabBgColor = badgeNoneBgColor;
  }
  if (changes.badgeNoneText) {
    badgeNoneTextColor = parseHexColorToRgba(changes.badgeNoneText.newValue, badgeNoneTextColor);
    if (!changes.badgeTabText) badgeTabTextColor = badgeNoneTextColor;
  }
  if (changes.badgeTabBg) badgeTabBgColor = parseHexColorToRgba(changes.badgeTabBg.newValue, badgeTabBgColor);
  if (changes.badgeTabText) badgeTabTextColor = parseHexColorToRgba(changes.badgeTabText.newValue, badgeTabTextColor);

  if (changes.includeBlankPages) includeBlankPages = !!changes.includeBlankPages.newValue;
  if (changes.windowScope) windowScope = (changes.windowScope.newValue === 'all') ? 'all' : 'current';
  if (changes.protectPinnedTabs) protectPinnedTabs = !!changes.protectPinnedTabs.newValue;
  if (changes.respectTabGroups) respectTabGroups = !!changes.respectTabGroups.newValue;
  if (changes.protectUniqueCurrentWindow) protectUniqueCurrentWindow = !!changes.protectUniqueCurrentWindow.newValue;

  if (changes.whitelistEnabled) whitelistEnabled = !!changes.whitelistEnabled.newValue;
  if (changes.whitelistList) whitelistRules = compileRuleList(changes.whitelistList.newValue);

  if (changes.blacklistSameWindow) blacklistSameWindowRules = compileRuleList(changes.blacklistSameWindow.newValue);
  if (changes.blacklistCrossWindow) blacklistCrossWindowRules = compileRuleList(changes.blacklistCrossWindow.newValue);

  if (changes.contentEqEnabled) contentEqEnabled = !!changes.contentEqEnabled.newValue;
  if (changes.contentEqDisableInWhitelist) contentEqDisableInWhitelist = !!changes.contentEqDisableInWhitelist.newValue;
  if (changes.contentEqUseManualRules) contentEqUseManualRules = !!changes.contentEqUseManualRules.newValue;
  if (changes.contentEqUseAutoRules) contentEqUseAutoRules = !!changes.contentEqUseAutoRules.newValue;
  if (changes.contentEqManualRuleList) contentEqManualRules = compileContentEquivalenceRules(changes.contentEqManualRuleList.newValue);
  if (changes.contentEqAutoRuleList) contentEqAutoRules = compileContentEquivalenceRules(changes.contentEqAutoRuleList.newValue);

  configRev++;
  scheduleRefreshBadge(80);
});


// =====================
// UI helpers
// =====================
function setIcon(type) {
  if (type === 'active')
    chrome.action.setIcon({ path: 'icon_128_gs.png' });
  else
    chrome.action.setIcon({ path: 'icon_128.png' });
}

function showActive() { setIcon('active'); setBadgeDisplay('M', 'dup'); }
function showInactive() { setIcon('inactive'); setBadgeDisplay('', ''); }

function setBadgeDisplay(msg, badgeMode) {
  // badgeMode:
  // - 'dup' ... duplicate-count theme
  // - 'tab' ... tab-count theme
  // - ''    ... no preference (falls back to tab theme)
  var mode = String(badgeMode || '');

  // Defaults when custom colors are disabled.
  var dupBgDefault = [255, 165, 0, 255];
  var dupTextDefault = [0, 0, 0, 255];
  var tabBgDefault = [0, 0, 0, 255];
  var tabTextDefault = [255, 255, 255, 255];

  var bg, fg;
  if (badgeColorsEnabled) {
    if (mode === 'dup') {
      bg = badgeDupBgColor; fg = badgeDupTextColor;
    } else {
      // Treat unknown/empty mode as 'tab'.
      bg = badgeTabBgColor; fg = badgeTabTextColor;
    }
  } else {
    if (mode === 'dup') {
      bg = dupBgDefault; fg = dupTextDefault;
    } else {
      bg = tabBgDefault; fg = tabTextDefault;
    }
  }

  chrome.action.setBadgeBackgroundColor({ color: bg });

  // Chrome supports setting the badge text color (MV3) on modern versions.
  // Guarded for older builds / stubs.
  try {
    if (chrome.action.setBadgeTextColor) {
      chrome.action.setBadgeTextColor({ color: fg });
    }
  } catch (e) {}

  chrome.action.setBadgeText({ text: String(msg || '') });
}

function formatBadgeNumber(n) {
  // Badge text is space-constrained. Cap to keep the badge readable.
  var v = parseInt(n, 10);
  if (!isFinite(v) || v < 0) v = 0;
  if (v > 999) return '999+';
  return String(v);
}


// =====================
// Messaging
// =====================
function handleMessage(message, sender, sendResponse) {
  stateChanged = false;

  if (message.command === 'config-changed') {
    loadConfigs(function () { scheduleRefreshBadge(0); });
  } else if (message.command === 'show-active') {
    showActive();
  } else if (message.command === 'show-inactive') {
    showInactive();
  } else if (message.command === 'refresh-badge') {
    scheduleRefreshBadge(0);
  } else if (message.command === 'get-state') {
    sendResponse({ data: { active: !stateChanged } });
  } else if (message.command === 'get-url-list') {
    sendResponse({ data: { list: urlList, dupUrls: dupUrls, domains: domains } });
  } else if (message.command === 'close-dup-tabs') {
    closeDuplicateTabs(sender && sender.tab ? sender.tab : null);
  } else {
    console.log('Unknown Command');
  }
}

chrome.runtime.onMessage.addListener(handleMessage);


// =====================
// Debounce refresh (performance)
// =====================
var refreshTimer = null;
function scheduleRefreshBadge(ms) {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(function () {
    refreshTimer = null;
    if (!configLoaded) {
      loadConfigs(function () { refreshBadge(); });
      return;
    }
    refreshBadge();
  }, (typeof ms === 'number' ? ms : 180));
}

function ensureFocusedWindowId(callback) {
  if (typeof lastFocusedWindowId === 'number') {
    if (typeof callback === 'function') callback(lastFocusedWindowId);
    return;
  }
  try {
    chrome.windows.getLastFocused({ populate: false }, function (win) {
      if (win && typeof win.id === 'number') lastFocusedWindowId = win.id;
      if (typeof callback === 'function') callback(lastFocusedWindowId);
    });
  } catch (e) {
    if (typeof callback === 'function') callback(lastFocusedWindowId);
  }
}


// =====================
// Query scope helpers
// =====================
function getQueryInfo(contextTab) {
  if (windowScope === 'all') return {};

  // current window
  if (contextTab && typeof contextTab.windowId === 'number') {
    return { windowId: contextTab.windowId };
  }

  return { currentWindow: true };
}


// =====================
// Planning (single pass)
// =====================
function buildPlan(tabs, scopeAllWindows, focusedWindowId) {
  // We build two parallel groupings:
  // - byUrl: comparableUrl => tabs (debug/info)
  // - byKey: de-dup bucket key => tabs (actual close plan)
  //
  // Key design:
  // - Base is either comparableUrl, or an equivalenceKey (domain-scoped canonicalization).
  // - If respectTabGroups is enabled, we append windowId:groupId to avoid cross-window collisions.
  //
  // IMPORTANT POLICY:
  // - Whitelist mode overrides blacklist mode. Content equivalence can still be applied when enabled.
  // - Pin/group constraints are applied as top-level constraints ("pin/group > whitelist > blacklist").
  var byUrl = Object.create(null);            // comparableUrl => tabs (debug/info)
  var byKey = Object.create(null);            // key => tabs (actual de-dup buckets)
  var urlLowerCache = Object.create(null);    // comparableUrl => lower
  var comparableCache = Object.create(null);  // tab.url => {url, isSuspended}

  // Build candidate maps
  for (var i = 0; i < tabs.length; i++) {
    var t = tabs[i];
    var rawUrl = t && t.url;
    if (!rawUrl) continue;

    // If enabled, map suspended-page wrapper URLs to their original URLs for de-duplication.
    var info = getComparableUrlInfo(rawUrl, comparableCache);
    var url = info && info.url ? info.url : rawUrl;

    // Stash for downstream tie-breakers (e.g., prefer closing suspended tabs).
    t._cdtIsSuspended = !!(info && info.isSuspended);
    t._cdtComparableUrl = url;

    var lower = urlLowerCache[url];
    if (!lower) {
      lower = toLower(url);
      urlLowerCache[url] = lower;
    }
    t._cdtComparableLower = lower;

    if (!shouldProcessUrl(url, lower)) continue;

    // Per-tab blacklist flags ("cleaner delete" requires per-tab, not per-bucket).
    // NOTE: Whitelist mode disables blacklist checks by policy.
    if (!whitelistEnabled) {
      t._cdtExcludedSame = matchRules(url, lower, blacklistSameWindowRules);
      t._cdtExcludedCross = matchRules(url, lower, blacklistCrossWindowRules);
    } else {
      t._cdtExcludedSame = false;
      t._cdtExcludedCross = false;
    }

    (byUrl[url] || (byUrl[url] = [])).push(t);

    // Optional: content-equivalence grouping (domain-scoped)
    var baseKey = url;
    var eqInfo = getContentEquivalenceInfo(url);
    if (eqInfo && eqInfo.key) {
      baseKey = 'eq:' + eqInfo.key;
      // Preference signal for keep-selection: keep the tab that already matches the canonical URL (if any).
      t._cdtEqCanonicalUrl = eqInfo.canonicalUrl || null;
    } else {
      t._cdtEqCanonicalUrl = null;
    }

    // Optional: group-aware de-dupe
    if (respectTabGroups) {
      // Group IDs are per-window; include windowId to avoid collisions across windows.
      var g = (typeof t.groupId === 'number') ? t.groupId : -1;
      if (g >= 0) baseKey = baseKey + '\n' + String(t.windowId) + ':' + String(g);
      else baseKey = baseKey + '\n-1';
    }

    (byKey[baseKey] || (byKey[baseKey] = [])).push(t);
  }

  // Expose candidate list (for get-url-list)
  urlList = byUrl;

  // Domains/dupUrls are informational only
  var domainSeen = Object.create(null);
  domains = [];
  dupUrls = [];

  var removeIds = [];
  var removeSeen = Object.create(null); // id => true

  function isRemoved(tab) {
    return !!(tab && typeof tab.id === 'number' && removeSeen[String(tab.id)]);
  }

  function markRemove(tab) {
    if (!tab || typeof tab.id !== 'number') return;
    if (protectPinnedTabs && !!tab.pinned) return;
    var k = String(tab.id);
    if (removeSeen[k]) return;
    removeSeen[k] = true;
    removeIds.push(tab.id);
  }

  function addInfoForGroup(group) {
    if (!group || group.length <= 1) return;

    // Pick a representative comparable URL for domain display.
    var repUrl = (group[0] && group[0]._cdtComparableUrl) ? group[0]._cdtComparableUrl : (group[0] ? group[0].url : '');

    var d = getDomain(repUrl);
    if (d && !domainSeen[d]) {
      domainSeen[d] = true;
      domains.push({ key: d, url: repUrl });
    }

    for (var j = 0; j < group.length; j++) {
      dupUrls.push({ id: group[j].id, title: group[j].title, url: group[j].url });
    }
  }

  function dedupeWithinWindow(windowTabs) {
    if (!windowTabs || windowTabs.length <= 1) return;

    // "Cleaner delete": if at least one tab is protected (pinned protection and/or same-window blacklist),
    // we remove ALL other unprotected duplicates.
    var protectedTabs = [];
    for (var i2 = 0; i2 < windowTabs.length; i2++) {
      var tt = windowTabs[i2];
      if (!tt) continue;
      if (protectPinnedTabs && !!tt.pinned) {
        protectedTabs.push(tt);
        continue;
      }
      if (!!tt._cdtExcludedSame) {
        protectedTabs.push(tt);
        continue;
      }
    }

    if (protectedTabs.length > 0) {
      for (var k2 = 0; k2 < windowTabs.length; k2++) {
        var tx = windowTabs[k2];
        if (!tx) continue;
        // Keep protected tabs; remove everything else.
        var keep = false;
        for (var p = 0; p < protectedTabs.length; p++) {
          if (protectedTabs[p].id === tx.id) { keep = true; break; }
        }
        if (!keep) markRemove(tx);
      }
      return;
    }

    // No protected tabs -> keep a single best keeper.
    var keeper = chooseKeeper(windowTabs);
    for (var k3 = 0; k3 < windowTabs.length; k3++) {
      var t3 = windowTabs[k3];
      if (!t3) continue;
      if (keeper && t3.id === keeper.id) continue;
      markRemove(t3);
    }
  }

  function removeCrossWindow(group, keepWindowId) {
    if (!group || group.length <= 1) return;
    for (var i3 = 0; i3 < group.length; i3++) {
      var t3 = group[i3];
      if (!t3) continue;
      if (t3.windowId === keepWindowId) continue;
      // Cross-window blacklist is per-tab; protected tabs are not removed in this stage.
      if (!!t3._cdtExcludedCross) continue;
      markRemove(t3);
    }
  }

  // Plan removals
  for (var key0 in byKey) {
    var group = byKey[key0];
    if (!group || group.length <= 1) continue;

    // Info lists
    addInfoForGroup(group);

    if (!scopeAllWindows) {
      // Only de-dupe within each window.
      var byWinLocal = groupTabsByWindow(group);
      for (var wKey in byWinLocal) {
        dedupeWithinWindow(byWinLocal[wKey]);
      }
      continue;
    }

    // De-dupe across windows:
    // Stage 1) Remove cross-window duplicates for tabs that are NOT excludedCross.
    // Stage 2) Within each window, remove duplicates for tabs that are NOT excludedSame.

    // If protectUniqueCurrentWindow is enabled: when a key appears EXACTLY once in the focused window,
    // we keep that focused tab and remove duplicates in other windows (when allowed).
    var forcedKeeper = null;
    if (protectUniqueCurrentWindow && typeof focusedWindowId === 'number') {
      var countInFocus = 0;
      var oneInFocus = null;
      for (var fx = 0; fx < group.length; fx++) {
        var tt = group[fx];
        if (tt && tt.windowId === focusedWindowId) {
          countInFocus++;
          if (!oneInFocus) oneInFocus = tt;
          if (countInFocus > 1) break;
        }
      }
      if (countInFocus === 1 && oneInFocus) forcedKeeper = oneInFocus;
    }

    // Determine a "keep window" for cross-window removal.
    var keepWindowId = null;
    if (forcedKeeper) {
      keepWindowId = forcedKeeper.windowId;
    } else {
      var keeperCross = chooseKeeper(group);
      keepWindowId = keeperCross ? keeperCross.windowId : null;
    }

    // Only perform cross-window removal if we have multiple windows in this group.
    if (keepWindowId !== null) {
      var winSeen = Object.create(null);
      var winCount = 0;
      for (var wx = 0; wx < group.length; wx++) {
        var tW = group[wx];
        if (!tW) continue;
        var wk = String(tW.windowId);
        if (!winSeen[wk]) {
          winSeen[wk] = true;
          winCount++;
          if (winCount > 1) break;
        }
      }
      if (winCount > 1) {
        removeCrossWindow(group, keepWindowId);
      }
    }

    // Stage 2: de-dupe within each window on the remaining tabs.
    var byWin = groupTabsByWindow(group);
    for (var winKey in byWin) {
      var wTabsAll = byWin[winKey];
      if (!wTabsAll || wTabsAll.length <= 1) continue;

      // Filter out tabs already scheduled for removal.
      var survivors = [];
      for (var sx = 0; sx < wTabsAll.length; sx++) {
        var ts = wTabsAll[sx];
        if (ts && !isRemoved(ts)) survivors.push(ts);
      }
      if (survivors.length <= 1) continue;

      dedupeWithinWindow(survivors);
    }
  }

  domains.sort(function (a, b) {
    return (a.key <= b.key ? -1 : 1);
  });

  dupUrls.sort(function (a, b) {
    var au = toLower(a.url);
    var bu = toLower(b.url);
    if (au === bu) {
      var at = (a.title || '');
      var bt = (b.title || '');
      return (at <= bt ? -1 : 1);
    }
    return (au <= bu ? -1 : 1);
  });

  return { removeIds: removeIds, removeCount: removeIds.length };
}



// =====================
// Auto-close (optional)
// =====================
function clearAutoCloseTimer() {
  if (autoCloseTimer) {
    clearTimeout(autoCloseTimer);
    autoCloseTimer = null;
  }
  autoCloseContextKey = '';
}

function getAutoCloseKey(focusedWindowId) {
  // Key is designed to invalidate timers across focus changes and config changes.
  return String(configRev) + '|' + windowScope + '|' + String(focusedWindowId || '');
}

function scheduleAutoCloseFromPlan(plan, focusedWindowId) {
  if (!autoCloseEnabled) {
    clearAutoCloseTimer();
    return;
  }
  var secs = (parseInt(autoCloseSeconds, 10) || 0);
  if (secs <= 0) {
    clearAutoCloseTimer();
    return;
  }
  if (!plan || !plan.removeIds || plan.removeIds.length === 0) {
    clearAutoCloseTimer();
    return;
  }
  if (typeof focusedWindowId !== 'number') return;

  var key = getAutoCloseKey(focusedWindowId);
  if (autoCloseTimer && autoCloseContextKey === key) return;

  clearAutoCloseTimer();
  autoCloseContextKey = key;
  autoCloseTimer = setTimeout(function () {
    // Abort if focus/config changed.
    if (autoCloseContextKey !== key) return;
    // Re-run close using the focused window as context.
    closeDuplicateTabs({ windowId: focusedWindowId });
  }, secs * 1000);
}

// =====================
// Badge
// =====================
function refreshBadge() {
  if (!configLoaded) return;

  ensureFocusedWindowId(function (focusedId) {
    // We may need all-tabs data to compute the badge tab count ("All windows").
    // For performance, we only query all tabs when necessary.
    var needAllTabs = (windowScope === 'all') || (badgeShowTabCount && badgeTabCountScope === 'all');
    var queryInfo = needAllTabs ? {} : getQueryInfo(null);

    chrome.tabs.query(queryInfo, function (tabs) {
      var planTabs = tabs;

      // If we're only de-duping within the focused window, but we queried all tabs for badge count,
      // filter the planning set down to the focused window.
      if (windowScope !== 'all' && needAllTabs && typeof focusedId === 'number') {
        planTabs = [];
        for (var i = 0; i < tabs.length; i++) {
          if (tabs[i].windowId === focusedId) planTabs.push(tabs[i]);
        }
      }

      var plan = buildPlan(planTabs, windowScope === 'all', focusedId);
      var duplicatesExist = (plan.removeCount > 0);

      // Compute a tab count for the badge (if enabled).
      var tabCount = 0;
      if (badgeTabCountScope === 'all') {
        tabCount = tabs.length;
      } else {
        if (needAllTabs && typeof focusedId === 'number') {
          for (var j = 0; j < tabs.length; j++) {
            if (tabs[j].windowId === focusedId) tabCount++;
          }
        } else {
          // tabs is already the focused window set.
          tabCount = tabs.length;
        }
      }

      // Decide what the badge text should show.
      // - If duplicates exist and duplicate count is enabled: show duplicates count (dup theme).
      // - Otherwise, if tab count is enabled: show tab count (tab theme).
      // - Otherwise: show nothing.
      var badgeText = '';
      var badgeMode = '';
      if (badgeShowDuplicateCount && duplicatesExist) {
        badgeText = formatBadgeNumber(plan.removeCount);
        badgeMode = 'dup';
      } else if (badgeShowTabCount) {
        badgeText = formatBadgeNumber(tabCount);
        badgeMode = 'tab';
      }

      setBadgeDisplay(badgeText, badgeMode);
      scheduleAutoCloseFromPlan(plan, focusedId);
    });
  });
}


// =====================
// Close logic
// =====================
function closeDuplicateTabs(contextTab) {
  // Avoid overlapping timers while executing a close action.
  clearAutoCloseTimer();
  var focusedId = (contextTab && typeof contextTab.windowId === 'number') ? contextTab.windowId : lastFocusedWindowId;
  chrome.tabs.query(getQueryInfo(contextTab), function (tabs) {
    var plan = buildPlan(tabs, windowScope === 'all', focusedId);

    if (plan.removeIds && plan.removeIds.length) {
      // Tabs may change between planning and execution; ignore "no tab" errors.
      chrome.tabs.remove(plan.removeIds, function () {
        // Ignore errors (e.g., tab already closed by the user/other extension).
        void chrome.runtime.lastError;
      });
    }

    stateChanged = true;
    scheduleRefreshBadge(0);
  });
}


// =====================
// Tab events (re-check on tab changes)
// =====================
chrome.tabs.onCreated.addListener(function () {
  stateChanged = true;
  scheduleRefreshBadge(180);
});

chrome.tabs.onUpdated.addListener(function (tabId, changeInfo) {
  if (changeInfo.status !== 'complete') return;
  stateChanged = true;
  scheduleRefreshBadge(180);
});

chrome.tabs.onRemoved.addListener(function () {
  stateChanged = true;
  scheduleRefreshBadge(180);
});

chrome.tabs.onReplaced.addListener(function () {
  stateChanged = true;
  scheduleRefreshBadge(180);
});

chrome.tabs.onActivated.addListener(function (activeInfo) {
  if (activeInfo && typeof activeInfo.windowId === 'number') lastFocusedWindowId = activeInfo.windowId;
  stateChanged = true;
  scheduleRefreshBadge(0);
});

chrome.windows.onFocusChanged.addListener(function (windowId) {
  if (typeof windowId !== 'number') return;
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  lastFocusedWindowId = windowId;
  stateChanged = true;
  scheduleRefreshBadge(0);
});


// =====================
// Init (service worker wakeups)
// =====================
function initTabUrl(tabs) {
  tabUrl = Object.create(null);
  for (var i = 0; i < tabs.length; i++) {
    tabUrl[tabs[i].id] = { url: tabs[i].url, title: tabs[i].title };
  }
}

function init() {
  loadConfigs(function () {
    chrome.tabs.query({}, function (tabs) {
      initTabUrl(tabs);
      scheduleRefreshBadge(0);
    });
  });
}

chrome.action.onClicked.addListener(function (tab) {
  closeDuplicateTabs(tab || null);
});

init();
