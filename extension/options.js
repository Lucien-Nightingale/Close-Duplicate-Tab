/* Options page logic for Close Duplicate Tabs (MV3)
 * - Validates regex inputs at save-time to avoid runtime SW errors.
 * - Supports content equivalence (domain-scoped canonicalization) controls.
 * - Supports badge colors by badge display mode (dup vs tab).
 */

function uniqPreserveOrder(list) {
  var seen = Object.create(null);
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var v = (list[i] || '').trim();
    if (!v) continue;
    var key = v.toLowerCase();
    if (seen[key]) continue;
    seen[key] = true;
    out.push(v);
  }
  return out;
}

function parseLines(text) {
  return uniqPreserveOrder(
    String(text || '')
      .split('\n')
      .map(function (s) { return (s || '').trim(); })
      .filter(function (s) { return !!s; })
  );
}

// =====================
// Settings resilience (sync + local backup)
// =====================
var SETTINGS_BACKUP_KEY = 'cdt_settings_backup_v1';
// Bump this if we ever do a breaking schema migration.
var CONFIG_SCHEMA_VERSION = 422;

function writeLocalBackup(data) {
  try {
    chrome.storage.local.set({
      [SETTINGS_BACKUP_KEY]: { v: 1, savedAt: Date.now(), data: data }
    });
  } catch (e) {}
}

// =====================
// Regex helpers (fragment rules + explicit regex rules)
// =====================
function normalizeRegexFlags(flags) {
  flags = (flags || '').replace(/[^gimsuyd]/g, '');
  flags = flags.replace(/[gy]/g, '');
  if (flags.indexOf('i') === -1) flags += 'i';
  return flags;
}

function normalizeExtractorFlags(flags) {
  // Extractors are for capturing IDs; do not force 'i' (IDs may be case-sensitive).
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
  if (s[0] === '/' && s.lastIndexOf('/') > 0) return true;
  return false;
}

function tryCompileRegex(line) {
  var v = (line || '').trim();
  if (!v) return { ok: true, re: null };

  // URL fragments (non-regex lines) are always valid.
  if (!isExplicitRegexLine(v)) return { ok: true, re: null };

  var lower = v.toLowerCase();

  // re:<pattern>
  if (lower.indexOf('re:') === 0) {
    var pat1 = v.slice(3).trim();
    if (!pat1) return { ok: false, error: new Error('Empty pattern') };
    try { return { ok: true, re: new RegExp(pat1, 'i') }; } catch (e1) { return { ok: false, error: e1 }; }
  }

  // regex:<pattern>
  if (lower.indexOf('regex:') === 0) {
    var pat2 = v.slice(6).trim();
    if (!pat2) return { ok: false, error: new Error('Empty pattern') };
    try { return { ok: true, re: new RegExp(pat2, 'i') }; } catch (e2) { return { ok: false, error: e2 }; }
  }

  // /pattern/flags
  if (v[0] === '/' && v.lastIndexOf('/') > 0) {
    var last = v.lastIndexOf('/');
    var pat = v.slice(1, last);
    var flags = normalizeRegexFlags(v.slice(last + 1) || '');
    try { return { ok: true, re: new RegExp(pat, flags) }; } catch (e3) { return { ok: false, error: e3 }; }
  }

  return { ok: false, error: new Error('Invalid regex format') };
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

function validateRegexList(label, list) {
  for (var i = 0; i < list.length; i++) {
    var v = (list[i] || '').trim();
    if (!v) continue;
    if (!isExplicitRegexLine(v)) continue; // literal fragment, skip regex validation
    var r = tryCompileRegex(v);
    if (!r.ok) {
      return { ok: false, label: label, value: v, error: r.error };
    }
  }
  return { ok: true };
}

function parseContentEqRuleLine(line) {
  line = (line || '').trim();
  if (!line) return null;

  var idx = line.indexOf('=>');
  if (idx < 0) return null;

  var hostSpec = (line.slice(0, idx) || '').trim();
  var rest = (line.slice(idx + 2) || '').trim();
  if (!hostSpec || !rest) return null;

  // Optional canonical target: use the LAST "=>" inside the remainder, but only if the tail is NOT an explicit regex.
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

  return {
    hostSpec: hostSpec,
    extractorSpecs: cleaned,
    canonicalTarget: canonicalTarget
  };
}

function validateContentEqRuleList(label, lines) {
  for (var i = 0; i < lines.length; i++) {
    var line = (lines[i] || '').trim();
    if (!line) continue;
    if (line[0] === '#') continue;
    if (line.indexOf('//') === 0) continue;

    var parsed = parseContentEqRuleLine(line);
    if (!parsed) {
      return { ok: false, label: label, value: line, error: new Error('Invalid rule (expected "<host> => <extractorRegex>")') };
    }

    var hostSpec = parsed.hostSpec;
    var extractorSpecs = parsed.extractorSpecs;
    var canonicalTarget = parsed.canonicalTarget;

    // Host: suffix or explicit regex.
    if (isExplicitRegexLine(hostSpec)) {
      var hr = tryCompileRegex(hostSpec);
      if (!hr.ok) {
        return { ok: false, label: label, value: hostSpec, error: hr.error };
      }
    }

    // Extractors must be explicit regex lines.
    for (var j = 0; j < extractorSpecs.length; j++) {
      var extractorSpec = extractorSpecs[j];
      if (!isExplicitRegexLine(extractorSpec)) {
        return {
          ok: false,
          label: label,
          value: extractorSpec,
          error: new Error('Extractor must be an explicit regex (re:/regex:/.../flags)')
        };
      }
      var er = parseExtractorRegexRule(extractorSpec);
      if (!er) {
        return { ok: false, label: label, value: extractorSpec, error: new Error('Invalid extractor regex') };
      }
    }

    // canonicalTarget is optional and intentionally permissive:
    // - hostname: www.google.com
    // - or full URL: https://www.google.com/?hl=$1
    if (canonicalTarget) {
      if (canonicalTarget.indexOf('=>') >= 0) {
        return { ok: false, label: label, value: canonicalTarget, error: new Error('Canonical target must not contain "=>"') };
      }
    }
  }
  return { ok: true };
}

// =====================
// Simple UI helpers
// =====================
function getWindowScope() {
  var windowScope = 'current';
  var scopeEls = document.querySelectorAll('input[name="windowScope"]');
  for (var i = 0; i < scopeEls.length; i++) {
    if (scopeEls[i].checked) {
      windowScope = scopeEls[i].value;
      break;
    }
  }
  return (windowScope === 'all') ? 'all' : 'current';
}

function setWindowScope(scope) {
  scope = (scope === 'all') ? 'all' : 'current';
  var scopeEls = document.querySelectorAll('input[name="windowScope"]');
  for (var i = 0; i < scopeEls.length; i++) {
    scopeEls[i].checked = (scopeEls[i].value === scope);
  }
}

function getRadioValue(name, fallback) {
  var els = document.querySelectorAll('input[name="' + name + '"]');
  for (var i = 0; i < els.length; i++) {
    if (els[i].checked) return els[i].value;
  }
  return fallback;
}

function setRadioValue(name, value) {
  var els = document.querySelectorAll('input[name="' + name + '"]');
  for (var i = 0; i < els.length; i++) {
    els[i].checked = (els[i].value === value);
  }
}

function setStatus(text, isError) {
  var st = document.getElementById('status');
  if (!st) return;
  st.style.color = isError ? '#c00' : '';
  st.textContent = text || '';
}

function setInferStatus(text, isError) {
  var st = document.getElementById('contentEqInferStatus');
  if (!st) return;
  st.style.color = isError ? '#c00' : '';
  st.textContent = text || '';
}

function setDisabledById(id, disabled) {
  var el = document.getElementById(id);
  if (!el) return;
  el.disabled = !!disabled;
  el.style.opacity = disabled ? '0.65' : '';
}

function setDisabledByName(name, disabled) {
  var els = document.querySelectorAll('input[name="' + name + '"]');
  for (var i = 0; i < els.length; i++) {
    els[i].disabled = !!disabled;
  }
}

function normalizeHexColor(input) {
  var s = String(input || '').trim();
  if (!s) return '';
  if (s[0] !== '#') s = '#' + s;
  var hex = s.slice(1);
  if (!/^[0-9a-fA-F]+$/.test(hex)) return '';
  if (hex.length === 3 || hex.length === 4) {
    // Expand short form (#RGB / #RGBA)
    var out = '';
    for (var i = 0; i < hex.length; i++) out += hex[i] + hex[i];
    hex = out;
  }
  if (!(hex.length === 6 || hex.length === 8)) return '';
  return '#' + hex.toUpperCase();
}

function requireValidHex(label, v, fallback) {
  var n = normalizeHexColor(v);
  if (!n) n = normalizeHexColor(fallback);
  if (!n) return { ok: false, label: label };
  return { ok: true, value: n };
}

function escapeRegExp(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// =====================
// Save / Restore
// =====================
var saving = false;
var saveQueued = false;

function saveOptions() {
  // Make the Save button reliably responsive even under rapid clicks.
  if (saving) {
    saveQueued = true;
    setStatus('Saving...');
    return;
  }

  // Basics
  var includeBlankPages = !!(document.getElementById('includeBlankPages') && document.getElementById('includeBlankPages').checked);
  var windowScope = getWindowScope();

  // Rules / protections
  var protectPinnedTabs = !!(document.getElementById('protectPinnedTabs') && document.getElementById('protectPinnedTabs').checked);
  var respectTabGroups = !!(document.getElementById('respectTabGroups') && document.getElementById('respectTabGroups').checked);
  var protectUniqueCurrentWindow = !!(document.getElementById('protectUniqueCurrentWindow') && document.getElementById('protectUniqueCurrentWindow').checked);

  // Suspended-tab options
  var suspendedUrlEnabled = !!(document.getElementById('suspendedUrlEnabled') && document.getElementById('suspendedUrlEnabled').checked);
  var suspendedCloseMode = getRadioValue('suspendedCloseMode', 'default');
  var suspIdsText = document.getElementById('suspenderExtensionIds') ? document.getElementById('suspenderExtensionIds').value : '';
  var suspenderExtensionIds = parseLines(suspIdsText).map(function (s) { return (s || '').toLowerCase(); });

  // Badge colors
  var badgeColorsEnabled = !!(document.getElementById('badgeColorsEnabled') && document.getElementById('badgeColorsEnabled').checked);
  var badgeDupBgRaw = document.getElementById('badgeDupBg') ? document.getElementById('badgeDupBg').value : '';
  var badgeDupTextRaw = document.getElementById('badgeDupText') ? document.getElementById('badgeDupText').value : '';
  var badgeTabBgRaw = document.getElementById('badgeTabBg') ? document.getElementById('badgeTabBg').value : '';
  var badgeTabTextRaw = document.getElementById('badgeTabText') ? document.getElementById('badgeTabText').value : '';

  // Badge text behavior
  var badgeShowDuplicateCount = !!(document.getElementById('badgeShowDuplicateCount') && document.getElementById('badgeShowDuplicateCount').checked);
  var badgeShowTabCount = !!(document.getElementById('badgeShowTabCount') && document.getElementById('badgeShowTabCount').checked);
  var badgeTabCountScope = getRadioValue('badgeTabCountScope', 'current');
  if (badgeTabCountScope !== 'all') badgeTabCountScope = 'current';

  // Auto-close options
  var autoCloseEnabled = !!(document.getElementById('autoCloseEnabled') && document.getElementById('autoCloseEnabled').checked);
  var autoCloseSecondsRaw = document.getElementById('autoCloseSeconds') ? document.getElementById('autoCloseSeconds').value : '';
  var autoCloseSeconds = parseInt(autoCloseSecondsRaw, 10);
  if (autoCloseEnabled) {
    if (!autoCloseSeconds || autoCloseSeconds < 1) {
      setStatus('Auto-close delay must be a positive number of seconds.', true);
      setTimeout(function () { setStatus(''); }, 2500);
      return;
    }
    if (autoCloseSeconds > 86400) autoCloseSeconds = 86400;
  } else {
    autoCloseSeconds = autoCloseSeconds || 0;
  }

  // Blacklist / whitelist
  var sameText = document.getElementById('blacklistSameWindow') ? document.getElementById('blacklistSameWindow').value : '';
  var crossText = document.getElementById('blacklistCrossWindow') ? document.getElementById('blacklistCrossWindow').value : '';
  var whitelistEnabled = !!(document.getElementById('whitelistEnabled') && document.getElementById('whitelistEnabled').checked);
  var whitelistText = document.getElementById('whitelistText') ? document.getElementById('whitelistText').value : '';

  var blacklistSameWindow = parseLines(sameText);
  var blacklistCrossWindow = parseLines(crossText);
  var whitelistList = parseLines(whitelistText);

  // Content equivalence
  var contentEqEnabled = !!(document.getElementById('contentEqEnabled') && document.getElementById('contentEqEnabled').checked);
  var contentEqDisableInWhitelist = !!(document.getElementById('contentEqDisableInWhitelist') && document.getElementById('contentEqDisableInWhitelist').checked);
  var contentEqUseAutoRules = !!(document.getElementById('contentEqUseAutoRules') && document.getElementById('contentEqUseAutoRules').checked);
  var contentEqUseManualRules = !!(document.getElementById('contentEqUseManualRules') && document.getElementById('contentEqUseManualRules').checked);
  var contentEqAutoRuleListText = document.getElementById('contentEqAutoRuleList') ? document.getElementById('contentEqAutoRuleList').value : '';
  var contentEqManualRuleListText = document.getElementById('contentEqManualRuleList') ? document.getElementById('contentEqManualRuleList').value : '';
  var contentEqAutoRuleList = parseLines(contentEqAutoRuleListText);
  var contentEqManualRuleList = parseLines(contentEqManualRuleListText);

  // Validate regex rules to avoid runtime errors.
  var v1 = validateRegexList('Blacklist (same window)', blacklistSameWindow);
  var v2 = validateRegexList('Blacklist (cross windows)', blacklistCrossWindow);
  var v3 = validateRegexList('Whitelist', whitelistList);
  var bad = (!v1.ok ? v1 : (!v2.ok ? v2 : (!v3.ok ? v3 : null)));
  if (bad) {
    setStatus('Invalid regex in ' + bad.label + ': ' + bad.value, true);
    setTimeout(function () { setStatus(''); }, 2500);
    return;
  }

  // Validate content equivalence rules (regardless of enable; keep stored clean).
  var ve1 = validateContentEqRuleList('Content equivalence (auto rules)', contentEqAutoRuleList);
  var ve2 = validateContentEqRuleList('Content equivalence (manual rules)', contentEqManualRuleList);
  var ebad = (!ve1.ok ? ve1 : (!ve2.ok ? ve2 : null));
  if (ebad) {
    setStatus('Invalid rule in ' + ebad.label + ': ' + ebad.value, true);
    setTimeout(function () { setStatus(''); }, 2500);
    return;
  }

  // Validate badge colors if enabled.
  var badgeDupBg = '';
  var badgeDupText = '';
  var badgeTabBg = '';
  var badgeTabText = '';
  if (badgeColorsEnabled) {
    var c1 = requireValidHex('Duplicate-count background color', badgeDupBgRaw, '#FFA500');
    var c2 = requireValidHex('Duplicate-count text color', badgeDupTextRaw, '#000000');
    var c3 = requireValidHex('Tab-count background color', badgeTabBgRaw, '#000000');
    var c4 = requireValidHex('Tab-count text color', badgeTabTextRaw, '#FFFFFF');
    var cbad = (!c1.ok ? c1 : (!c2.ok ? c2 : (!c3.ok ? c3 : (!c4.ok ? c4 : null))));
    if (cbad) {
      setStatus('Invalid hex color: ' + cbad.label, true);
      setTimeout(function () { setStatus(''); }, 2500);
      return;
    }
    badgeDupBg = c1.value;
    badgeDupText = c2.value;
    badgeTabBg = c3.value;
    badgeTabText = c4.value;
  }

  saving = true;
  setStatus('Saving...');

  var toSave = {
    includeBlankPages: includeBlankPages,
    windowScope: windowScope,
    protectPinnedTabs: protectPinnedTabs,
    respectTabGroups: respectTabGroups,
    protectUniqueCurrentWindow: protectUniqueCurrentWindow,

    suspendedUrlEnabled: suspendedUrlEnabled,
    suspendedCloseMode: (suspendedCloseMode === 'closeSuspended' || suspendedCloseMode === 'closeNormal') ? suspendedCloseMode : 'default',
    suspenderExtensionIds: suspenderExtensionIds,

    badgeColorsEnabled: badgeColorsEnabled,
    badgeShowDuplicateCount: badgeShowDuplicateCount,
    badgeShowTabCount: badgeShowTabCount,
    badgeTabCountScope: badgeTabCountScope,
    badgeDupBg: badgeDupBg,
    badgeDupText: badgeDupText,
    badgeTabBg: badgeTabBg,
    badgeTabText: badgeTabText,

    // Legacy (older versions used badgeNone*). Keep in sync for downgrade compatibility.
    badgeNoneBg: badgeTabBg,
    badgeNoneText: badgeTabText,

    autoCloseEnabled: autoCloseEnabled,
    autoCloseSeconds: autoCloseSeconds,

    blacklistSameWindow: blacklistSameWindow,
    blacklistCrossWindow: blacklistCrossWindow,
    whitelistEnabled: whitelistEnabled,
    whitelistList: whitelistList,

    contentEqEnabled: contentEqEnabled,
    contentEqDisableInWhitelist: contentEqDisableInWhitelist,
contentEqUseAutoRules: contentEqUseAutoRules,
    contentEqUseManualRules: contentEqUseManualRules,
    contentEqAutoRuleList: contentEqAutoRuleList,
    contentEqManualRuleList: contentEqManualRuleList,
    // For forward-compatible migrations + easier recovery.
    configSchemaVersion: CONFIG_SCHEMA_VERSION
  };

  // Always keep a local backup so upgrades / sync quota issues don't wipe settings.
  writeLocalBackup(toSave);

  chrome.storage.sync.set(toSave, function () {
    saving = false;

    if (chrome.runtime && chrome.runtime.lastError) {
      setStatus('Save failed: ' + chrome.runtime.lastError.message, true);
      return;
    }

    // Nudge the service worker to refresh instantly (in case it's asleep).
    try { chrome.runtime.sendMessage({ command: 'config-changed' }); } catch (e) {}

    setStatus('Saved.');
    setTimeout(function () { setStatus(''); }, 900);

    if (saveQueued) {
      saveQueued = false;
      setTimeout(saveOptions, 0);
    }
  });
}

function restoreOptions() {
  var CONFIG_KEYS = [
    // Basics
    'includeBlankPages',
    'windowScope',

    // Protections
    'protectPinnedTabs',
    'respectTabGroups',
    'protectUniqueCurrentWindow',

    // Suspended
    'suspendedUrlEnabled',
    'suspendedCloseMode',
    'suspenderExtensionIds',

    // Badge
    'badgeColorsEnabled',
    'badgeShowDuplicateCount',
    'badgeShowTabCount',
    'badgeTabCountScope',
    'badgeDupBg',
    'badgeDupText',
    'badgeTabBg',
    'badgeTabText',
    'badgeNoneBg',      // legacy
    'badgeNoneText',    // legacy

    // Auto close
    'autoCloseEnabled',
    'autoCloseSeconds',

    // Rules
    'blacklistSameWindow',
    'blacklistCrossWindow',
    'whitelistEnabled',
    'whitelistList',
    'filterList', // legacy (single blacklist)

    // Content equivalence
    'contentEqEnabled',
    'contentEqDisableInWhitelist',
    'contentEqUseAutoRules',
    'contentEqUseManualRules',
    'contentEqAutoRuleList',
    'contentEqManualRuleList',

    // Metadata / migration
    'configSchemaVersion'
  ];

  chrome.storage.sync.get(CONFIG_KEYS, function (syncItems) {
    chrome.storage.local.get([SETTINGS_BACKUP_KEY], function (li) {
      // Merge with local backup (sync wins). This avoids data loss if sync storage
      // is cleared or a future version changes keys.
      var backup = li && li[SETTINGS_BACKUP_KEY];
      var backupData = (backup && backup.data && typeof backup.data === 'object') ? backup.data : null;

      var items = syncItems || {};
      if (backupData) {
        // Shallow merge: backup fills missing keys, sync overrides.
        items = Object.assign({}, backupData, items);
      }

      // Refresh local backup on load (best-effort).
      writeLocalBackup(items);

      // Defaults
      var includeBlankPages = !!items.includeBlankPages;
      var windowScope = (items.windowScope === 'all') ? 'all' : 'current';

    var protectPinnedTabs = ('protectPinnedTabs' in items) ? !!items.protectPinnedTabs : false;
    var respectTabGroups = ('respectTabGroups' in items) ? !!items.respectTabGroups : false;
    var protectUniqueCurrentWindow = ('protectUniqueCurrentWindow' in items) ? !!items.protectUniqueCurrentWindow : true;

    var suspendedUrlEnabled = ('suspendedUrlEnabled' in items) ? !!items.suspendedUrlEnabled : false;
    var suspendedCloseMode = (items.suspendedCloseMode === 'closeSuspended' || items.suspendedCloseMode === 'closeNormal') ? items.suspendedCloseMode : 'default';
    var suspenderExtensionIds = Array.isArray(items.suspenderExtensionIds) ? items.suspenderExtensionIds : [];

    var badgeColorsEnabled = ('badgeColorsEnabled' in items) ? !!items.badgeColorsEnabled : false;
    var badgeShowDuplicateCount = ('badgeShowDuplicateCount' in items) ? !!items.badgeShowDuplicateCount : true;
    var badgeShowTabCount = ('badgeShowTabCount' in items) ? !!items.badgeShowTabCount : false;
    var badgeTabCountScope = (items.badgeTabCountScope === 'all') ? 'all' : 'current';

    var badgeDupBg = items.badgeDupBg || '';
    var badgeDupText = items.badgeDupText || '';

    // New tab-mode colors; fall back to legacy badgeNone* if needed.
    var badgeTabBg = items.badgeTabBg || items.badgeNoneBg || '';
    var badgeTabText = items.badgeTabText || items.badgeNoneText || '';

    var autoCloseEnabled = ('autoCloseEnabled' in items) ? !!items.autoCloseEnabled : false;
    var autoCloseSeconds = (typeof items.autoCloseSeconds === 'number') ? items.autoCloseSeconds : 10;

    var blacklistSameWindow = Array.isArray(items.blacklistSameWindow) ? items.blacklistSameWindow : [];
    var blacklistCrossWindow = Array.isArray(items.blacklistCrossWindow) ? items.blacklistCrossWindow : [];
    var whitelistEnabled = ('whitelistEnabled' in items) ? !!items.whitelistEnabled : false;
    var whitelistList = Array.isArray(items.whitelistList) ? items.whitelistList : [];

    // Legacy migration: if the new lists are empty but filterList exists, populate both.
    if ((!blacklistSameWindow || blacklistSameWindow.length === 0) && Array.isArray(items.filterList) && items.filterList.length) {
      blacklistSameWindow = items.filterList.slice(0);
      blacklistCrossWindow = items.filterList.slice(0);
    }

    var contentEqEnabled = ('contentEqEnabled' in items) ? !!items.contentEqEnabled : false;
    var contentEqDisableInWhitelist = ('contentEqDisableInWhitelist' in items) ? !!items.contentEqDisableInWhitelist : true;
    var contentEqUseAutoRules = ('contentEqUseAutoRules' in items) ? !!items.contentEqUseAutoRules : true;
    var contentEqUseManualRules = ('contentEqUseManualRules' in items) ? !!items.contentEqUseManualRules : true;
    var contentEqAutoRuleList = Array.isArray(items.contentEqAutoRuleList) ? items.contentEqAutoRuleList : [];
    var contentEqManualRuleList = Array.isArray(items.contentEqManualRuleList) ? items.contentEqManualRuleList : [];

    // Populate UI
    var ibp = document.getElementById('includeBlankPages');
    if (ibp) ibp.checked = includeBlankPages;

    setWindowScope(windowScope);

    var pp = document.getElementById('protectPinnedTabs');
    if (pp) pp.checked = protectPinnedTabs;

    var rtg = document.getElementById('respectTabGroups');
    if (rtg) rtg.checked = respectTabGroups;

    var pucw = document.getElementById('protectUniqueCurrentWindow');
    if (pucw) pucw.checked = protectUniqueCurrentWindow;

    var susp = document.getElementById('suspendedUrlEnabled');
    if (susp) susp.checked = suspendedUrlEnabled;

    setRadioValue('suspendedCloseMode', suspendedCloseMode);

    var idsEl = document.getElementById('suspenderExtensionIds');
    if (idsEl) idsEl.value = (suspenderExtensionIds || []).join('\n');

    var bc = document.getElementById('badgeColorsEnabled');
    if (bc) bc.checked = badgeColorsEnabled;

    var bsd = document.getElementById('badgeShowDuplicateCount');
    if (bsd) bsd.checked = badgeShowDuplicateCount;

    var bst = document.getElementById('badgeShowTabCount');
    if (bst) bst.checked = badgeShowTabCount;

    setRadioValue('badgeTabCountScope', badgeTabCountScope);

    var dupBgEl = document.getElementById('badgeDupBg');
    if (dupBgEl) dupBgEl.value = badgeDupBg;

    var dupTextEl = document.getElementById('badgeDupText');
    if (dupTextEl) dupTextEl.value = badgeDupText;

    var tabBgEl = document.getElementById('badgeTabBg');
    if (tabBgEl) tabBgEl.value = badgeTabBg;

    var tabTextEl = document.getElementById('badgeTabText');
    if (tabTextEl) tabTextEl.value = badgeTabText;

    var ac = document.getElementById('autoCloseEnabled');
    if (ac) ac.checked = autoCloseEnabled;

    var acs = document.getElementById('autoCloseSeconds');
    if (acs) acs.value = String(autoCloseSeconds || '');

    var sameEl = document.getElementById('blacklistSameWindow');
    if (sameEl) sameEl.value = (blacklistSameWindow || []).join('\n');

    var crossEl = document.getElementById('blacklistCrossWindow');
    if (crossEl) crossEl.value = (blacklistCrossWindow || []).join('\n');

    var wlEnabledEl = document.getElementById('whitelistEnabled');
    if (wlEnabledEl) wlEnabledEl.checked = whitelistEnabled;

    var wlEl = document.getElementById('whitelistText');
    if (wlEl) wlEl.value = (whitelistList || []).join('\n');

    var ce = document.getElementById('contentEqEnabled');
    if (ce) ce.checked = contentEqEnabled;

    var ceDw = document.getElementById('contentEqDisableInWhitelist');
    if (ceDw) ceDw.checked = contentEqDisableInWhitelist;

    var cea = document.getElementById('contentEqUseAutoRules');
    if (cea) cea.checked = contentEqUseAutoRules;

    var cem = document.getElementById('contentEqUseManualRules');
    if (cem) cem.checked = contentEqUseManualRules;

    var ceAuto = document.getElementById('contentEqAutoRuleList');
    if (ceAuto) ceAuto.value = (contentEqAutoRuleList || []).join('\n');

    var ceManual = document.getElementById('contentEqManualRuleList');
    if (ceManual) ceManual.value = (contentEqManualRuleList || []).join('\n');

    // Clear infer status on load
    setInferStatus('');

      // Run once after initial restore.
      updateDependentUi();
    });
  });
}

// =====================
// Dependent UI toggles
// =====================
function updateDependentUi() {
  // Suspended controls depend on suspendedUrlEnabled
  var susp = document.getElementById('suspendedUrlEnabled');
  var suspDisabled = !(susp && susp.checked);
  setDisabledById('suspenderExtensionIds', suspDisabled);
  setDisabledByName('suspendedCloseMode', suspDisabled);

  // Tab-count scope depends on badgeShowTabCount
  var bt = document.getElementById('badgeShowTabCount');
  var btDisabled = !(bt && bt.checked);
  setDisabledByName('badgeTabCountScope', btDisabled);

  // Badge colors depend on badgeColorsEnabled
  var bc = document.getElementById('badgeColorsEnabled');
  var bcDisabled = !(bc && bc.checked);
  setDisabledById('badgeDupBg', bcDisabled);
  setDisabledById('badgeDupText', bcDisabled);
  setDisabledById('badgeTabBg', bcDisabled);
  setDisabledById('badgeTabText', bcDisabled);

  // Content equivalence: stays editable regardless of mode.
  var ce = document.getElementById('contentEqEnabled');
  var ceEnabled = !!(ce && ce.checked);

  // Keep content-equivalence controls editable even when the feature is currently inactive
  // (e.g., users may want to prepare rules before enabling).
  setDisabledById('contentEqEnabled', false);
  setDisabledById('contentEqDisableInWhitelist', false);
  setDisabledById('contentEqUseAutoRules', false);
  setDisabledById('contentEqUseManualRules', false);
  setDisabledById('contentEqAutoRuleList', false);
  setDisabledById('contentEqManualRuleList', false);
  setDisabledById('contentEqSamples', false);
  setDisabledById('contentEqInferBtn', false);

  // Visual hint for the whole card: dim when the master switch is off.
  var card = document.getElementById('contentEqCard');
  if (card) card.style.opacity = (!ceEnabled) ? '0.65' : '';
}

// =====================
// Content equivalence inference
// =====================
function inferCanonicalizationFallback(urls) {
  try {
    if (!urls || urls.length < 2) return null;

    // All samples are already confirmed to be same host by caller.
    var hostLower = (urls[0].host || '').toLowerCase();
    if (!hostLower) return null;

    // Choose canonicalTarget = simplest URL (fewest params, then shortest).
    var best = urls[0];
    function paramCount(u) {
      var n = 0;
      try { u.searchParams.forEach(function () { n++; }); } catch (e) {}
      return n;
    }
    for (var i = 1; i < urls.length; i++) {
      var u = urls[i];
      var a = paramCount(u);
      var b = paramCount(best);
      if (a < b) { best = u; continue; }
      if (a === b && String(u.href || '').length < String(best.href || '').length) { best = u; }
    }

    // Try to detect a frequent first path segment (e.g., /webhp).
    var segCount = Object.create(null);
    for (var j = 0; j < urls.length; j++) {
      var pn = String(urls[j].pathname || '');
      var segs = pn.split('/').filter(function (x) { return !!x; });
      if (segs.length) {
        var s0 = segs[0];
        segCount[s0] = (segCount[s0] || 0) + 1;
      }
    }
    var commonSeg = null;
    var bestN = 0;
    Object.keys(segCount).forEach(function (k) {
      var n = segCount[k] || 0;
      if (n > bestN) { bestN = n; commonSeg = k; }
    });

    // Only use the segment if it appears in at least 2 samples.
    if (bestN < 2) commonSeg = null;

    var hostEsc = escapeRegExp(hostLower);
    var segPart = commonSeg ? ('(?:/(?:' + escapeRegExp(commonSeg) + '))?') : '';
    var reBody = '^(?:https?:\\\\/\\\\/)?(' + hostEsc + ')' + segPart + '(?:/(?:$|[\\\\?#])|[\\\\?#]|$)';

    // Rule line:
    // <host> => re:<regex> => <canonicalTarget>
    return hostLower + ' => re:' + reBody + ' => ' + String(best.href || '');
  } catch (e2) {
    return null;
  }
}

function inferContentEq() {
  var samplesEl = document.getElementById('contentEqSamples');
  var outEl = document.getElementById('contentEqAutoRuleList');
  if (!samplesEl || !outEl) return;

  setInferStatus('');

  var lines = parseLines(samplesEl.value);
  if (!lines.length) {
    setInferStatus('No samples.', true);
    return;
  }

  // Parse URLs
  var urls = [];
  for (var i = 0; i < lines.length; i++) {
    var s = lines[i];
    try {
      var u = new URL(s);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      urls.push(u);
    } catch (e) {
      // ignore bad
    }
  }
  if (!urls.length) {
    setInferStatus('No valid http(s) URLs in samples.', true);
    return;
  }

  // Host analysis
  var hostSet = Object.create(null);
  for (var j = 0; j < urls.length; j++) {
    hostSet[(urls[j].host || '').toLowerCase()] = true;
  }
  var hosts = Object.keys(hostSet);

  function addRules(ruleLines) {
    // Validate generated lines quickly.
    var v = validateContentEqRuleList('Generated rules', ruleLines);
    if (!v.ok) {
      setInferStatus('Generated invalid rule: ' + v.value, true);
      return;
    }
    var existing = parseLines(outEl.value);
    var merged = existing.slice(0);
    for (var k = 0; k < ruleLines.length; k++) merged.push(ruleLines[k]);
    merged = uniqPreserveOrder(merged);
    outEl.value = merged.join('\n');
    setInferStatus('Added ' + ruleLines.length + ' rule(s) to Auto rules. Remember to Save.', false);
  }

  // YouTube special-case
  var isYouTube = false;
  for (var h = 0; h < hosts.length; h++) {
    var hl = hosts[h];
    if (hl === 'youtu.be' || hl.endsWith('.youtu.be') || hl === 'youtube.com' || hl.endsWith('.youtube.com')) {
      isYouTube = true;
    } else if (hl === 'www.youtube.com' || hl.endsWith('.youtube.com')) {
      isYouTube = true;
    }
  }
  if (isYouTube) {
    addRules([
      'youtube.com, youtu.be => re:(?:[?&]v=|/(?:shorts|embed|live|v)/|youtu\\.be/)([A-Za-z0-9_-]{6,})'
    ]);
    return;
  }

  // Generic inference: require a single host (or close)
  if (hosts.length !== 1) {
    setInferStatus('Generic inference needs a single host in samples (got ' + hosts.length + ').', true);
    return;
  }

  // Find a query parameter that exists in all samples and has the same non-empty value.
  var base = urls[0].searchParams;
  var candidates = Object.create(null);
  base.forEach(function (v, k) { candidates[k] = v; });

  for (var uix = 1; uix < urls.length; uix++) {
    var sp = urls[uix].searchParams;
    for (var k0 in candidates) {
      if (!sp.has(k0)) { delete candidates[k0]; continue; }
      if (sp.get(k0) !== candidates[k0]) { delete candidates[k0]; continue; }
      if (!candidates[k0]) { delete candidates[k0]; continue; }
    }
  }

  var keys = Object.keys(candidates);
  if (!keys.length) {
    // Fallback (experimental): suggest a canonicalization skeleton based on host + (optional) common first path segment.
    var fallbackRule = inferCanonicalizationFallback(urls);
    if (fallbackRule) {
      addRules([fallbackRule]);
      return;
    }
    setInferStatus('Could not infer a stable shared query parameter. Add a manual rule.', true);
    return;
  }

  // Prefer common ID-ish keys
  var preferred = ['id', 'v', 'video', 'item', 'itemid', 'sku', 'product', 'pid'];
  var picked = keys[0];
  for (var p = 0; p < preferred.length; p++) {
    if (Object.prototype.hasOwnProperty.call(candidates, preferred[p])) { picked = preferred[p]; break; }
  }

  // Host spec: use the host without port, as a suffix rule.
  var hostSpec2 = hosts[0].split(':')[0];

  addRules([
    hostSpec2 + ' => re:[?&]' + escapeRegExp(picked) + '=([^&]+)'
  ]);
}

// =====================
// Wiring
// =====================
document.addEventListener('DOMContentLoaded', restoreOptions);

var saveBtn = document.getElementById('save');
if (saveBtn) saveBtn.addEventListener('click', saveOptions);

var inferBtn = document.getElementById('contentEqInferBtn');
if (inferBtn) inferBtn.addEventListener('click', inferContentEq);

// Keep dependent controls consistent as the user toggles master switches.
document.addEventListener('change', function (e) {
  var t = e && e.target;
  if (!t) return;
  var id = t.id || '';
  if (
    id === 'suspendedUrlEnabled' ||
    id === 'badgeColorsEnabled' ||
    id === 'badgeShowTabCount' ||
    id === 'whitelistEnabled' ||
    id === 'contentEqEnabled' ||
    id === 'contentEqUseAutoRules' ||
    id === 'contentEqUseManualRules'
  ) {
    updateDependentUi();
  }
});

// Power-user: Ctrl+S / Cmd+S triggers save.
document.addEventListener('keydown', function (e) {
  if (!e) return;
  var key = (e.key || '').toLowerCase();
  var isMac = navigator.platform && /mac/i.test(navigator.platform);
  var mod = isMac ? e.metaKey : e.ctrlKey;
  if (mod && key === 's') {
    e.preventDefault();
    saveOptions();
  }
});
