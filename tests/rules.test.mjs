import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function loadWorker() {
  const code = readFileSync(resolve('extension', 'close_tabs.js'), 'utf8');

  const chromeStub = {
    windows: { WINDOW_ID_NONE: -1, onFocusChanged: { addListener() {} } },
    tabs: {
      query(_q, cb) { cb([]); },
      remove(_ids, cb) { cb?.(); },
      onCreated: { addListener() {} },
      onUpdated: { addListener() {} },
      onRemoved: { addListener() {} },
      onReplaced: { addListener() {} },
      onActivated: { addListener() {} }
    },
    action: {
      setBadgeText(_o, cb) { cb?.(); },
      setBadgeBackgroundColor(_o, cb) { cb?.(); },
      setBadgeTextColor(_o, cb) { cb?.(); },
      setIcon(_o, cb) { cb?.(); },
      onClicked: { addListener() {} }
    },
    runtime: {
      lastError: null,
      onMessage: { addListener() {} }
    },
    storage: {
      sync: {
        get(_keys, cb) { cb({}); },
        set(_obj, cb) { cb?.(); }
      },
      local: {
        get(_keys, cb) { cb({}); },
        set(_obj, cb) { cb?.(); }
      },
      onChanged: { addListener() {} }
    }
  };

  const context = vm.createContext({ chrome: chromeStub, console, setTimeout, clearTimeout, URL, Object, Array, RegExp, String, Number, Boolean, Math });
  vm.runInContext(code, context, { filename: 'close_tabs.js' });
  return context;
}

const ctx = loadWorker();

// Ensure core helpers exist
assert.equal(typeof ctx.compileRuleList, 'function');
assert.equal(typeof ctx.matchRules, 'function');

test('URL fragment rules match substring without escaping', () => {
  const rules = ctx.compileRuleList(['youtube.com/watch?v=']);
  assert.equal(rules.re.length, 0);
  assert.equal(rules.url.length, 1);
  const url = 'https://www.youtube.com/watch?v=7pLPImSAozY&t=1138s';
  assert.equal(ctx.matchRules(url, url.toLowerCase(), rules), true);
});

test('Regex rules require explicit prefix or /.../ syntax and run first', () => {
  const rules = ctx.compileRuleList(['re:watch\\?v=7pLPImSAozY', 'youtube.com/watch?v=NOT_THIS']);
  const url = 'https://www.youtube.com/watch?v=7pLPImSAozY&t=1138s';
  assert.equal(ctx.matchRules(url, url.toLowerCase(), rules), true);
});

test('Regex /.../g is normalized to ignore g/y and force i', () => {
  const re = ctx.parseRegexRule('/YouTube\.Com/gi');
  assert.ok(re instanceof RegExp);
  // should still match case-insensitively
  assert.equal(re.test('https://www.youtube.com/'), true);
});


test('Suspended-tab wrapper URL is decoded to original when enabled + extension ID matches', () => {
  // Enable suspended URL handling in the worker context
  ctx.suspendedUrlEnabled = true;
  ctx.suspenderExtensionIdSet = ctx.compileExtensionIdSet(['noogafoofpebimajpfpamcfhoaifemoa']);

  const wrapper = 'chrome-extension://noogafoofpebimajpfpamcfhoaifemoa/suspended.html#ttl=Codex%20App&pos=800&uri=https%3A%2F%2Fopenai.com%2Fzh-Hant%2Fform%2Fcodex-app%2F';
  const orig = ctx.parseSuspendedOriginalUrl(wrapper);
  assert.equal(orig, 'https://openai.com/zh-Hant/form/codex-app/');
});

test('Suspended-tab wrapper URL is ignored when extension ID does not match', () => {
  ctx.suspendedUrlEnabled = true;
  ctx.suspenderExtensionIdSet = ctx.compileExtensionIdSet(['someotherextensionid000000000000']);

  const wrapper = 'chrome-extension://noogafoofpebimajpfpamcfhoaifemoa/suspended.html#uri=https%3A%2F%2Fexample.com%2F';
  const orig = ctx.parseSuspendedOriginalUrl(wrapper);
  assert.equal(orig, null);
});

test('Prefer-close-suspended tie-breaker keeps normal tab when candidates are equally pinned+active', () => {
  ctx.suspendedCloseMode = 'closeSuspended';

  const a = { id: 1, pinned: false, active: false, index: 5, _cdtIsSuspended: true };
  const b = { id: 2, pinned: false, active: false, index: 9, _cdtIsSuspended: false };

  const keep = ctx.chooseKeeper([a, b]);
  assert.equal(keep.id, 2);
});

test('Active tab still wins over prefer-close-suspended tie-breaker', () => {
  ctx.suspendedCloseMode = 'closeSuspended';

  const a = { id: 1, pinned: false, active: true, index: 5, _cdtIsSuspended: true };
  const b = { id: 2, pinned: false, active: false, index: 0, _cdtIsSuspended: false };

  const keep = ctx.chooseKeeper([a, b]);
  assert.equal(keep.id, 1);
});

test('Prefer-close-non-suspended tie-breaker keeps suspended tab when candidates are equally pinned+active', () => {
  ctx.suspendedCloseMode = 'closeNormal';

  const a = { id: 1, pinned: false, active: false, index: 0, _cdtIsSuspended: true };
  const b = { id: 2, pinned: false, active: false, index: 1, _cdtIsSuspended: false };

  const keep = ctx.chooseKeeper([a, b]);
  assert.equal(keep.id, 1);
});


test('Equivalence extractor normalizes + and %20 for query values', () => {
  const rules = ctx.compileContentEquivalenceRules(['example.com => re:[?&]q=([^&]+)']);
  ctx.contentEqEnabled = true;
  ctx.whitelistEnabled = false;
  ctx.contentEqUseManualRules = true;
  ctx.contentEqUseAutoRules = false;
  ctx.contentEqManualRules = rules;

  const a = ctx.getContentEquivalenceInfo('https://example.com/search?q=hello+world');
  const b = ctx.getContentEquivalenceInfo('https://example.com/search?q=hello%20world');
  const c = ctx.getContentEquivalenceInfo('https://example.com/search?q=hello+word');
  const d = ctx.getContentEquivalenceInfo('https://example.com/search?q=hello%20word');

  assert.ok(a && b && c && d);
  assert.equal(a.key, b.key);
  assert.equal(c.key, d.key);
  assert.notEqual(a.key, c.key);
});


test('Canonical redirects are applied even if an earlier rule matches without redirect', () => {
  const rules = ctx.compileContentEquivalenceRules([
    'a.com => re:[?&]id=([^&]+)',
    'a.com => re:[?&]redir=([^&]+) => b.com/path?x=$1',
    'b.com => re:[?&]x=([^&]+)'
  ]);

  ctx.contentEqEnabled = true;
  ctx.whitelistEnabled = false;
  ctx.contentEqUseManualRules = true;
  ctx.contentEqUseAutoRules = false;
  ctx.contentEqManualRules = rules;

  const info = ctx.getContentEquivalenceInfo('https://a.com/page?id=111&redir=222');
  assert.ok(info);
  assert.equal(info.effectiveUrl, 'https://b.com/path?x=222');
  assert.equal(info.canonicalUrl, 'https://b.com/path?x=222');
  assert.equal(info.key, 'manual|h:b.com|222');
});


test('Canonical redirects iterate until stable (multi-step redirects)', () => {
  const rules = ctx.compileContentEquivalenceRules([
    'a.com => re:[?&]redir=([^&]+) => b.com/path?x=$1',
    'b.com => re:[?&]x=([^&]+) => c.com/final?y=$1',
    'c.com => re:[?&]y=([^&]+)'
  ]);

  ctx.contentEqEnabled = true;
  ctx.whitelistEnabled = false;
  ctx.contentEqUseManualRules = true;
  ctx.contentEqUseAutoRules = false;
  ctx.contentEqManualRules = rules;

  const info = ctx.getContentEquivalenceInfo('https://a.com/?redir=777');
  assert.ok(info);
  assert.equal(info.effectiveUrl, 'https://c.com/final?y=777');
  assert.equal(info.canonicalUrl, 'https://c.com/final?y=777');
  assert.equal(info.key, 'manual|h:c.com|777');
});
test('Multi-host content equivalence rule shares one scope across hosts', () => {
  const rules = ctx.compileContentEquivalenceRules([
    'youtube.com, youtu.be => re:(?:[?&]v=|/(?:shorts|embed|live|v)/|youtu\\.be/)([A-Za-z0-9_-]{6,})'
  ]);

  ctx.contentEqEnabled = true;
  ctx.whitelistEnabled = false;
  ctx.contentEqDisableInWhitelist = true;
  ctx.contentEqUseManualRules = true;
  ctx.contentEqUseAutoRules = false;
  ctx.contentEqManualRules = rules;

  const a = ctx.getContentEquivalenceInfo('https://www.youtube.com/watch?v=iLCDSY2XX7E');
  const b = ctx.getContentEquivalenceInfo('https://youtu.be/iLCDSY2XX7E');
  const c = ctx.getContentEquivalenceInfo('https://youtu.be/iLCDSY2XX7E?t=1029');

  assert.ok(a && b && c);
  assert.equal(a.key, b.key);
  assert.equal(b.key, c.key);
});

test('Content equivalence can be disabled in whitelist mode via option', () => {
  const rules = ctx.compileContentEquivalenceRules(['example.com => re:[?&]q=([^&]+)']);

  ctx.contentEqEnabled = true;
  ctx.contentEqUseManualRules = true;
  ctx.contentEqUseAutoRules = false;
  ctx.contentEqManualRules = rules;

  ctx.whitelistEnabled = true;
  ctx.contentEqDisableInWhitelist = true;
  assert.equal(ctx.getContentEquivalenceInfo('https://example.com/search?q=hello+world'), null);

  ctx.contentEqDisableInWhitelist = false;
  assert.ok(ctx.getContentEquivalenceInfo('https://example.com/search?q=hello+world'));
});
