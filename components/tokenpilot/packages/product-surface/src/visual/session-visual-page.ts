export function renderVisualPageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>LightMem2 Visual</title>
  <style>
    :root {
      --bg: #f4f1ea;
      --panel: rgba(255, 252, 246, 0.92);
      --panel-strong: #fffdf8;
      --line: rgba(77, 63, 44, 0.14);
      --text: #2f261c;
      --muted: #796958;
      --accent: #0f766e;
      --accent-soft: rgba(15, 118, 110, 0.1);
      --shadow: 0 18px 40px rgba(63, 45, 25, 0.08);
      --radius: 18px;
      --sidebar-width: 252px;
      --sidebar-collapsed: 52px;
      --font-sans: "IBM Plex Sans", "Helvetica Neue", sans-serif;
      --font-mono: "IBM Plex Mono", "SFMono-Regular", monospace;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: var(--font-sans);
      color: var(--text);
      background:
        radial-gradient(circle at top left, rgba(15, 118, 110, 0.12), transparent 34%),
        linear-gradient(180deg, #f7f4ee 0%, var(--bg) 100%);
    }
    .app {
      display: grid;
      grid-template-columns: var(--sidebar-width) 1fr;
      min-height: 100vh;
      transition: grid-template-columns 180ms ease;
    }
    .app.collapsed {
      grid-template-columns: var(--sidebar-collapsed) 1fr;
    }
    .sidebar {
      border-right: 1px solid var(--line);
      background: rgba(255, 250, 243, 0.82);
      backdrop-filter: blur(18px);
      padding: 16px 12px;
      overflow: hidden;
    }
    .sidebar-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 14px;
    }
    .collapse-btn, .nav-btn, .tab-btn {
      border: 1px solid var(--line);
      background: var(--panel-strong);
      color: var(--text);
      border-radius: 12px;
      cursor: pointer;
    }
    .collapse-btn {
      width: 28px;
      height: 28px;
      font-size: 15px;
      flex: 0 0 auto;
    }
    .brand {
      font-size: 13px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .sidebar-copy {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
      margin-bottom: 14px;
    }
    .host-select {
      width: 100%;
      margin-bottom: 12px;
      padding: 10px 12px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: var(--panel-strong);
      color: var(--text);
      font: inherit;
    }
    .session-list {
      display: grid;
      gap: 8px;
    }
    .session-item {
      width: 100%;
      border: 1px solid transparent;
      background: transparent;
      color: inherit;
      border-radius: 14px;
      padding: 10px 12px;
      text-align: left;
      cursor: pointer;
      transition: background 140ms ease, border-color 140ms ease, transform 140ms ease;
    }
    .session-item:hover {
      background: rgba(255, 255, 255, 0.55);
      border-color: var(--line);
      transform: translateX(1px);
    }
    .session-item.active {
      background: var(--accent-soft);
      border-color: rgba(15, 118, 110, 0.2);
    }
    .session-id {
      font-size: 12px;
      line-height: 1.4;
      word-break: break-all;
    }
    .session-meta {
      margin-top: 6px;
      font-size: 11px;
      color: var(--muted);
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .collapsed .brand,
    .collapsed .sidebar-copy,
    .collapsed .session-item .session-id,
    .collapsed .session-item .session-meta {
      display: none;
    }
    .collapsed .session-item {
      padding: 10px 8px;
      min-height: 40px;
      background: rgba(255, 255, 255, 0.48);
      border-color: var(--line);
    }
    .collapsed .session-item::before {
      content: attr(data-index);
      font-size: 12px;
      color: var(--muted);
    }
    .main {
      padding: 28px;
      overflow: auto;
    }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 22px;
    }
    .title {
      font-size: 28px;
      line-height: 1.1;
      margin: 0 0 6px;
    }
    .subtitle {
      margin: 0;
      color: var(--muted);
      font-size: 14px;
    }
    .tabs {
      display: inline-flex;
      gap: 8px;
      padding: 4px;
      border: 1px solid var(--line);
      border-radius: 16px;
      background: rgba(255, 255, 255, 0.52);
    }
    .tab-btn {
      padding: 10px 14px;
      background: transparent;
    }
    .tab-btn.active {
      background: var(--panel-strong);
      border-color: rgba(15, 118, 110, 0.18);
      color: var(--accent);
    }
    .panel {
      background: var(--panel);
      border: 1px solid rgba(255, 255, 255, 0.48);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      padding: 20px;
    }
    .overview {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }
    .overview-card {
      border: 1px solid var(--line);
      border-radius: 16px;
      background: rgba(255, 255, 255, 0.74);
      padding: 14px 16px;
      transition: border-color 140ms ease, transform 140ms ease, background 140ms ease;
      text-align: left;
      color: inherit;
      width: 100%;
      cursor: pointer;
    }
    .overview-card.active {
      border-color: rgba(15, 118, 110, 0.26);
      background: rgba(15, 118, 110, 0.08);
      transform: translateY(-1px);
    }
    .overview-card:hover {
      border-color: rgba(15, 118, 110, 0.2);
      transform: translateY(-1px);
    }
    .overview-label {
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 8px;
    }
    .overview-value {
      font-size: 24px;
      line-height: 1;
      margin-bottom: 6px;
    }
    .overview-meta {
      font-size: 12px;
      color: var(--muted);
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .panel-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 18px;
    }
    .panel-title {
      margin: 0;
      font-size: 18px;
    }
    .panel-meta {
      margin-top: 6px;
      color: var(--muted);
      font-size: 12px;
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .pager {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .nav-btn {
      padding: 8px 12px;
    }
    .nav-btn:disabled {
      cursor: not-allowed;
      opacity: 0.45;
    }
    .pager-label {
      font-size: 12px;
      color: var(--muted);
      min-width: 72px;
      text-align: center;
    }
    .compare {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }
    .pane {
      border: 1px solid var(--line);
      border-radius: 16px;
      background: rgba(255, 255, 255, 0.72);
      overflow: hidden;
      min-height: 320px;
    }
    .pane-label {
      padding: 12px 14px;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      border-bottom: 1px solid var(--line);
      color: var(--muted);
      background: rgba(255, 255, 255, 0.68);
    }
    .diff-block {
      border: 1px solid var(--line);
      border-radius: 16px;
      background: rgba(255, 255, 255, 0.76);
      overflow: hidden;
    }
    .diff-lines {
      margin: 0;
      padding: 14px 16px;
      font-family: var(--font-mono);
      font-size: 12px;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .diff-line {
      display: block;
      padding: 1px 0;
    }
    .diff-line.add {
      background: rgba(15, 118, 110, 0.1);
      color: #0b5b55;
    }
    .diff-line.del {
      background: rgba(190, 24, 93, 0.08);
      color: #8b1e47;
    }
    .diff-line.ctx {
      color: var(--muted);
    }
    pre {
      margin: 0;
      padding: 16px;
      font-family: var(--font-mono);
      font-size: 12px;
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 72vh;
      overflow: auto;
    }
    .stats {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-bottom: 16px;
    }
    .selector-layout {
      display: grid;
      gap: 12px;
      margin-bottom: 16px;
    }
    .selector-heading {
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 6px;
    }
    .segment-list {
      display: grid;
      gap: 8px;
    }
    .segment-btn {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.74);
      color: inherit;
      padding: 12px 14px;
      text-align: left;
      cursor: pointer;
      transition: border-color 140ms ease, transform 140ms ease, background 140ms ease;
    }
    .segment-btn:hover {
      border-color: rgba(15, 118, 110, 0.22);
      transform: translateY(-1px);
    }
    .segment-btn.active {
      border-color: rgba(15, 118, 110, 0.28);
      background: rgba(15, 118, 110, 0.08);
    }
    .segment-meta {
      margin-top: 6px;
      font-size: 12px;
      line-height: 1.5;
      color: var(--muted);
      word-break: break-word;
    }
    .chip {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 8px 12px;
      font-size: 12px;
      background: rgba(255, 255, 255, 0.78);
    }
    .pass-list {
      margin-top: 12px;
      display: grid;
      gap: 8px;
    }
    .pass-item {
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 10px 12px;
      background: rgba(255, 255, 255, 0.64);
      font-size: 12px;
      line-height: 1.5;
    }
    .empty {
      padding: 38px 20px;
      text-align: center;
      color: var(--muted);
      border: 1px dashed var(--line);
      border-radius: 16px;
      background: rgba(255, 255, 255, 0.4);
    }
    @media (max-width: 980px) {
      .app, .app.collapsed {
        grid-template-columns: 1fr;
      }
      .sidebar {
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }
      .collapsed .brand,
      .collapsed .sidebar-copy,
      .collapsed .session-item .session-id,
      .collapsed .session-item .session-meta {
        display: initial;
      }
      .collapsed .session-item::before {
        content: "";
      }
      .compare {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div id="app" class="app">
    <aside class="sidebar">
      <div class="sidebar-header">
        <button id="collapseBtn" class="collapse-btn" type="button" aria-label="Toggle sidebar">‹</button>
        <div class="brand">LightMem2 Visual</div>
      </div>
      <div class="sidebar-copy">Switch hosts, pick a session, then inspect stability, reduction, or eviction snapshots one event at a time.</div>
      <select id="hostSelect" class="host-select" aria-label="Select host"></select>
      <div id="sessionList" class="session-list"></div>
    </aside>
    <main class="main">
      <div class="topbar">
        <div>
          <h1 class="title">Stability / Reduction / Eviction</h1>
          <p id="subtitle" class="subtitle">Loading sessions…</p>
        </div>
        <div class="tabs">
          <button id="tabStability" class="tab-btn active" type="button">Stability</button>
          <button id="tabReduction" class="tab-btn" type="button">Reduction</button>
          <button id="tabEviction" class="tab-btn" type="button">Eviction</button>
        </div>
      </div>
      <section id="overviewRoot" class="overview"></section>
      <section class="panel">
        <div class="panel-header">
          <div>
            <h2 id="panelTitle" class="panel-title">No session selected</h2>
            <div id="panelMeta" class="panel-meta"></div>
          </div>
          <div class="pager">
            <button id="prevBtn" class="nav-btn" type="button">Previous</button>
            <div id="pagerLabel" class="pager-label">0 / 0</div>
            <button id="nextBtn" class="nav-btn" type="button">Next</button>
          </div>
        </div>
        <div id="stats" class="stats"></div>
        <div id="compareRoot"></div>
        <div id="passRoot"></div>
      </section>
    </main>
  </div>
  <script src="/app.js"></script>
</body>
</html>`;
}

export function renderVisualPageScript(): string {
  return `const state = {
  hosts: [],
  sessions: [],
  activeHost: new URL(window.location.href).searchParams.get("host") || "",
  activeSessionId: new URL(window.location.href).searchParams.get("session") || "",
  activeTab: new URL(window.location.href).searchParams.get("tab") || "stability",
  indexes: { stability: 0, reduction: 0, eviction: 0 },
  sessionData: new Map(),
  lastSessionByHost: {},
  collapsed: false,
  reductionSegmentIndex: 0,
  reductionActiveCallKey: "",
  fingerprintGroupsExpanded: false,
};

const el = {
  app: document.getElementById("app"),
  collapseBtn: document.getElementById("collapseBtn"),
  hostSelect: document.getElementById("hostSelect"),
  sessionList: document.getElementById("sessionList"),
  subtitle: document.getElementById("subtitle"),
  overviewRoot: document.getElementById("overviewRoot"),
  tabStability: document.getElementById("tabStability"),
  tabReduction: document.getElementById("tabReduction"),
  tabEviction: document.getElementById("tabEviction"),
  panelTitle: document.getElementById("panelTitle"),
  panelMeta: document.getElementById("panelMeta"),
  pagerLabel: document.getElementById("pagerLabel"),
  prevBtn: document.getElementById("prevBtn"),
  nextBtn: document.getElementById("nextBtn"),
  stats: document.getElementById("stats"),
  compareRoot: document.getElementById("compareRoot"),
  passRoot: document.getElementById("passRoot"),
};

function fmtDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function fmtInt(value) {
  return new Intl.NumberFormat("en-US").format(Number(value || 0));
}

function clampIndex(index, length) {
  if (!Number.isFinite(index) || length <= 0) return 0;
  return Math.max(0, Math.min(Math.trunc(index), length - 1));
}

function savingsSummary(item) {
  if (!item) return "";
  const mode = item.latestCountMode;
  const tokenSavedCount = Number(item.tokenSavedCount || 0);
  const charSavedCount = Number(item.charSavedCount || 0);
  if (mode !== "chars" && tokenSavedCount > 0) return "saved " + fmtInt(tokenSavedCount) + " tok";
  if (charSavedCount > 0) return "saved " + fmtInt(charSavedCount) + " ch";
  if (tokenSavedCount > 0) return "saved " + fmtInt(tokenSavedCount) + " tok";
  return "";
}

function escapeHtml(text) {
  return String(text || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function diffLines(beforeText, afterText) {
  const before = String(beforeText || "").split("\\n");
  const after = String(afterText || "").split("\\n");
  const dp = Array.from({ length: before.length + 1 }, () => Array(after.length + 1).fill(0));
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      if (before[i] === after[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }
  const lines = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      lines.push({ type: "ctx", text: "  " + before[i] });
      i += 1;
      j += 1;
      continue;
    }
    if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push({ type: "del", text: "- " + before[i] });
      i += 1;
    } else {
      lines.push({ type: "add", text: "+ " + after[j] });
      j += 1;
    }
  }
  while (i < before.length) {
    lines.push({ type: "del", text: "- " + before[i] });
    i += 1;
  }
  while (j < after.length) {
    lines.push({ type: "add", text: "+ " + after[j] });
    j += 1;
  }
  const changedIndexes = lines
    .map((line, index) => line.type === "ctx" ? -1 : index)
    .filter((index) => index >= 0);
  if (changedIndexes.length === 0) return [];
  const keep = new Set();
  for (const index of changedIndexes) {
    for (let i = Math.max(0, index - 1); i <= Math.min(lines.length - 1, index + 1); i += 1) {
      keep.add(i);
    }
  }
  const compact = [];
  let previous = -2;
  for (let i = 0; i < lines.length; i += 1) {
    if (!keep.has(i)) continue;
    if (i > previous + 1) compact.push({ type: "ctx", text: "..." });
    compact.push(lines[i]);
    previous = i;
  }
  return compact;
}

function renderDiffBlock(title, beforeText, afterText) {
  const lines = diffLines(beforeText, afterText);
  if (lines.length === 0) {
    return '<div class="diff-block"><div class="pane-label">' + escapeHtml(title) + '</div><div class="diff-lines"><span class="diff-line ctx">No change</span></div></div>';
  }
  return '<div class="diff-block"><div class="pane-label">' + escapeHtml(title) + '</div><div class="diff-lines">'
    + lines.map((line) => '<span class="diff-line ' + escapeHtml(line.type) + '">' + escapeHtml(line.text) + '</span>').join("")
    + '</div></div>';
}

function renderCacheAuditPanel(cacheAuditSummary) {
  if (!cacheAuditSummary) return "";
  const entropy = Array.isArray(cacheAuditSummary.topEntropyKinds) && cacheAuditSummary.topEntropyKinds.length > 0
    ? cacheAuditSummary.topEntropyKinds.map((entry) => entry.key + "=" + fmtInt(entry.count)).join(", ")
    : "(none)";
  const drift = Array.isArray(cacheAuditSummary.topDriftKeys) && cacheAuditSummary.topDriftKeys.length > 0
    ? cacheAuditSummary.topDriftKeys.map((entry) => entry.key + "=" + fmtInt(entry.count)).join(", ")
    : "(none)";
  const rewriteCount = Number(
    cacheAuditSummary.responsePromptCacheKeyRewriteCount
    ?? cacheAuditSummary.promptCacheKeyMismatchCount
    ?? 0,
  );
  return '<div class="pass-list" style="margin-top:16px;">'
    + '<div class="pass-item"><strong>Cache Audit</strong><br />'
    + 'warm hits=' + escapeHtml(fmtInt(cacheAuditSummary.warmHits || 0))
    + ' / ' + escapeHtml(fmtInt(cacheAuditSummary.warmCandidates || 0))
    + ' · misses=' + escapeHtml(fmtInt(cacheAuditSummary.warmMisses || 0))
    + ' · hit rate=' + escapeHtml(String(cacheAuditSummary.hitRatePercent || 0)) + '%'
    + '<br />response key rewrites=' + escapeHtml(fmtInt(rewriteCount))
    + '<br />entropy hotspots=' + escapeHtml(entropy)
    + '<br />drift hotspots=' + escapeHtml(drift)
    + '</div>'
    + '</div>';
}

function renderCacheAuditRecentTable(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return "";
  return '<div class="pass-list" style="margin-top:16px;">'
    + entries.map((entry, index) => {
      const requestKey = entry.requestPromptCacheKey || "-";
      const responseKey = entry.responsePromptCacheKey || "-";
      const entropy = Array.isArray(entry.entropyKinds) && entry.entropyKinds.length > 0
        ? entry.entropyKinds.join(", ")
        : "(none)";
      const drift = Array.isArray(entry.driftKeys) && entry.driftKeys.length > 0
        ? entry.driftKeys.join(", ")
        : "(none)";
      return '<div class="pass-item"><strong>Recent Cache Request #' + escapeHtml(String(index + 1)) + '</strong>'
        + '<br />at=' + escapeHtml(fmtDate(entry.at))
        + ' · status=' + escapeHtml(fmtInt(entry.status))
        + ' · cached tokens=' + escapeHtml(fmtInt(entry.cachedInputTokens))
        + ' · stream=' + escapeHtml(String(Boolean(entry.stream)))
        + '<br />model=' + escapeHtml(entry.model || "-")
        + ' · fingerprint=' + escapeHtml(entry.stablePrefixFingerprint || "-")
        + '<br />request key=' + escapeHtml(requestKey)
        + '<br />response key=' + escapeHtml(responseKey)
        + '<br />entropy=' + escapeHtml(entropy)
        + '<br />drift=' + escapeHtml(drift)
        + '</div>';
    }).join("")
    + '</div>';
}

function renderCacheAuditFingerprintGroups(groups) {
  if (!Array.isArray(groups) || groups.length === 0) return "";
  const visibleGroups = state.fingerprintGroupsExpanded ? groups : groups.slice(0, 1);
  return '<div class="pass-list" style="margin-top:16px;">'
    + visibleGroups.map((group, index) => {
      const groupNumber = index + 1;
      const isLatest = index === 0;
      const requestKeys = Array.isArray(group.requestPromptCacheKeys) && group.requestPromptCacheKeys.length > 0
        ? group.requestPromptCacheKeys.join(", ")
        : "(none)";
      const responseKeys = Array.isArray(group.responsePromptCacheKeys) && group.responsePromptCacheKeys.length > 0
        ? group.responsePromptCacheKeys.join(", ")
        : "(none)";
      const entropy = Array.isArray(group.entropyKinds) && group.entropyKinds.length > 0
        ? group.entropyKinds.join(", ")
        : "(none)";
      const drift = Array.isArray(group.driftKeys) && group.driftKeys.length > 0
        ? group.driftKeys.join(", ")
        : "(none)";
      return '<div class="pass-item"><strong>Fingerprint Group #' + escapeHtml(String(groupNumber)) + '</strong>'
        + (isLatest ? ' · latest' : '')
        + '<br />fingerprint=' + escapeHtml(group.stablePrefixFingerprint || "-")
        + ' · requests=' + escapeHtml(fmtInt(group.requestCount))
        + ' · warm hits=' + escapeHtml(fmtInt(group.warmHitCount))
        + ' · rewrites=' + escapeHtml(fmtInt(group.rewriteCount))
        + '<br />latest=' + escapeHtml(fmtDate(group.latestAt))
        + ' · model=' + escapeHtml(group.latestModel || "-")
        + '<br />request keys=' + escapeHtml(requestKeys)
        + '<br />response keys=' + escapeHtml(responseKeys)
        + '<br />entropy=' + escapeHtml(entropy)
        + '<br />drift=' + escapeHtml(drift)
        + '</div>';
    }).join("")
    + (groups.length > 1
      ? '<button id="toggleFingerprintGroupsBtn" class="nav-btn" type="button" style="margin-top:8px;">'
        + escapeHtml(state.fingerprintGroupsExpanded
          ? 'Show fewer fingerprint groups'
          : 'Show all ' + fmtInt(groups.length) + ' fingerprint groups')
        + '</button>'
      : '')
    + '</div>';
}

function findMatchingCacheAuditEntry(item, entries) {
  if (!item || !Array.isArray(entries) || entries.length === 0) return null;
  const exactResponseMatch = entries.find((entry) =>
    entry
    && entry.responsePromptCacheKey
    && item.promptCacheKeyAfter
    && entry.responsePromptCacheKey === item.promptCacheKeyAfter,
  );
  if (exactResponseMatch) return exactResponseMatch;
  const exactRequestMatch = entries.find((entry) =>
    entry
    && entry.requestPromptCacheKey
    && item.promptCacheKeyAfter
    && entry.requestPromptCacheKey === item.promptCacheKeyAfter,
  );
  if (exactRequestMatch) return exactRequestMatch;
  if (!item.at) return entries[0] || null;
  const itemTime = new Date(item.at).getTime();
  if (!Number.isFinite(itemTime)) return entries[0] || null;
  let bestEntry = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const entry of entries) {
    if (!entry?.at) continue;
    const entryTime = new Date(entry.at).getTime();
    if (!Number.isFinite(entryTime)) continue;
    const delta = Math.abs(entryTime - itemTime);
    if (delta > 15 * 1000) continue;
    if (delta < bestDelta) {
      bestEntry = entry;
      bestDelta = delta;
    }
  }
  return bestEntry || entries[0] || null;
}

function findMatchingCacheAuditGroup(entry, groups) {
  if (!entry || !Array.isArray(groups) || groups.length === 0) return null;
  return groups.find((group) =>
    group && group.stablePrefixFingerprint === entry.stablePrefixFingerprint,
  ) || null;
}

function renderPromptCacheTransition(item, matchedCacheEntry, matchedFingerprintGroup, cacheAuditSummary) {
  const matchedFingerprint = matchedFingerprintGroup?.stablePrefixFingerprint
    || matchedCacheEntry?.stablePrefixFingerprint
    || "-";
  const matchedRequestKey = matchedCacheEntry?.requestPromptCacheKey || "-";
  const matchedResponseKey = matchedCacheEntry?.responsePromptCacheKey || "-";
  const warmSummary = cacheAuditSummary && Number(cacheAuditSummary.warmCandidates || 0) > 0
    ? fmtInt(cacheAuditSummary.warmHits || 0) + "/" + fmtInt(cacheAuditSummary.warmCandidates || 0)
      + " (" + String(cacheAuditSummary.hitRatePercent || 0) + "%)"
    : "0/0";
  return '<div class="pass-list" style="margin-top:16px;">'
    + '<div class="pass-item"><strong>Prefix Stability Snapshot</strong>'
    + '<br />prompt cache transition=' + escapeHtml(item.promptCacheKeyBefore || "-")
    + ' -> ' + escapeHtml(item.promptCacheKeyAfter || "-")
    + '<br />matched fingerprint=' + escapeHtml(matchedFingerprint)
    + ' · warm hits=' + escapeHtml(warmSummary)
    + '<br />matched request key=' + escapeHtml(matchedRequestKey)
    + '<br />matched response key=' + escapeHtml(matchedResponseKey)
    + '</div>'
    + '</div>';
}

function renderStabilityContextPanels(item) {
  return '<div class="pass-list" style="margin-top:16px;">'
    + '<div class="diff-block"><div class="pane-label">Developer Before</div><pre>' + escapeHtml(item.developerBefore || "") + '</pre></div>'
    + '<div class="diff-block"><div class="pane-label">Developer Canonical</div><pre>' + escapeHtml(item.developerCanonical || "") + '</pre></div>'
    + '<div class="diff-block"><div class="pane-label">Developer Forwarded</div><pre>' + escapeHtml(item.developerForwarded || "") + '</pre></div>'
    + '</div>';
}

function buildReductionCallKey(item) {
  if (!item) return "";
  return String(item.requestId || "") + "::" + String(item.at || "");
}

function syncReductionSegmentSelection(item) {
  const segments = Array.isArray(item && item.segments) ? item.segments : [];
  const callKey = buildReductionCallKey(item);
  if (state.reductionActiveCallKey !== callKey) {
    state.reductionActiveCallKey = callKey;
    state.reductionSegmentIndex = 0;
  }
  state.reductionSegmentIndex = clampIndex(state.reductionSegmentIndex, segments.length);
  return segments[state.reductionSegmentIndex] || null;
}

async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error("HTTP " + response.status);
  return response.json();
}

async function loadHosts() {
  const payload = await fetchJson("/api/hosts");
  state.hosts = Array.isArray(payload.hosts) ? payload.hosts : [];
  if (!state.activeHost && state.hosts.length > 0) {
    state.activeHost = state.hosts[0].hostId;
  }
  renderHostSelect();
  renderHostOverview();
}

async function loadSessions() {
  await loadHosts();
  if (!state.activeHost) {
    state.sessions = [];
    renderSessionList();
    renderEmpty("No visual hosts available yet.");
    return;
  }
  const payload = await fetchJson("/api/sessions?host=" + encodeURIComponent(state.activeHost));
  state.sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
  const preferredSessionId = state.lastSessionByHost[state.activeHost] || state.activeSessionId;
  const matchedSession = preferredSessionId
    ? state.sessions.find((session) => session.sessionId === preferredSessionId)
    : undefined;
  if (matchedSession) {
    state.activeSessionId = matchedSession.sessionId;
  } else if (state.sessions.length > 0) {
    state.activeSessionId = state.sessions[0].sessionId;
  } else {
    state.activeSessionId = "";
  }
  renderSessionList();
  if (state.activeSessionId) {
    await loadSession(state.activeSessionId);
  } else {
    renderEmpty("No visual snapshots yet. Run a few TokenPilot turns first, then refresh this page.");
  }
}

function renderHostSelect() {
  if (!el.hostSelect) return;
  el.hostSelect.innerHTML = state.hosts.map((host) => {
    const selected = host.hostId === state.activeHost ? " selected" : "";
    return '<option value="' + escapeHtml(host.hostId) + '"' + selected + '>'
      + escapeHtml(host.displayName + " (" + fmtInt(host.sessionCount) + ")")
      + '</option>';
  }).join("");
}

function renderHostOverview() {
  if (!el.overviewRoot) return;
  if (!Array.isArray(state.hosts) || state.hosts.length === 0) {
    el.overviewRoot.innerHTML = "";
    return;
  }
  el.overviewRoot.innerHTML = state.hosts.map((host) => {
    const active = host.hostId === state.activeHost ? " active" : "";
    const savings = savingsSummary(host);
    const cache = host.cacheWarmCandidates > 0
      ? 'cache ' + fmtInt(host.cacheWarmHits) + '/' + fmtInt(host.cacheWarmCandidates) + ' (' + host.cacheHitRatePercent + '%)'
      : '';
    return '<button class="overview-card' + active + '" data-host-id="' + escapeHtml(host.hostId) + '" type="button">'
      + '<div class="overview-label">' + escapeHtml(host.displayName) + '</div>'
      + '<div class="overview-value">' + escapeHtml(fmtInt(host.sessionCount)) + '</div>'
      + '<div class="overview-meta">'
      + '<span>S ' + escapeHtml(fmtInt(host.stabilityCount)) + '</span>'
      + '<span>R ' + escapeHtml(fmtInt(host.reductionCount)) + '</span>'
      + '<span>E ' + escapeHtml(fmtInt(host.evictionCount)) + '</span>'
      + '</div>'
      + (savings ? '<div class="overview-meta"><span>' + escapeHtml(savings) + '</span></div>' : '')
      + (cache ? '<div class="overview-meta"><span>' + escapeHtml(cache) + '</span></div>' : '')
      + '<div class="overview-meta">'
      + '<span>latest ' + escapeHtml(fmtDate(host.latestAt) || "-") + '</span>'
      + '</div>'
      + '</button>';
  }).join("");
  el.overviewRoot.querySelectorAll(".overview-card").forEach((node) => {
    node.addEventListener("click", () => {
      const hostId = node.getAttribute("data-host-id") || "";
      if (!hostId || hostId === state.activeHost) return;
      void setActiveHost(hostId);
    });
  });
}

async function loadSession(sessionId) {
  if (!sessionId) return;
  state.activeSessionId = sessionId;
  state.reductionSegmentIndex = 0;
  state.reductionActiveCallKey = "";
  state.fingerprintGroupsExpanded = false;
  if (state.activeHost) {
    state.lastSessionByHost[state.activeHost] = sessionId;
  }
  const query = new URL(window.location.href);
  query.searchParams.set("host", state.activeHost || "");
  query.searchParams.set("session", sessionId);
  query.searchParams.set("tab", state.activeTab);
  history.replaceState(null, "", query.toString());
  const sessionKey = (state.activeHost || "") + "::" + sessionId;
  if (!state.sessionData.has(sessionKey)) {
    const payload = await fetchJson("/api/session?host=" + encodeURIComponent(state.activeHost || "") + "&sessionId=" + encodeURIComponent(sessionId));
    state.sessionData.set(sessionKey, payload);
  }
  renderSessionList();
  renderActiveView();
}

function renderSessionList() {
  if (state.sessions.length === 0) {
    el.sessionList.innerHTML = '<div class="empty">No sessions</div>';
    renderHostOverview();
    el.subtitle.textContent = state.activeHost
      ? "No visual snapshots available yet for " + state.activeHost + "."
      : "No visual snapshots available yet.";
    return;
  }
  const activeHost = state.hosts.find((host) => host.hostId === state.activeHost);
  renderHostOverview();
  el.subtitle.textContent = state.activeSessionId
    ? (activeHost ? activeHost.displayName + " · " : "") + "Session " + state.activeSessionId
    : activeHost
      ? activeHost.displayName + " · Pick a session from the left."
      : "Pick a session from the left.";
  el.sessionList.innerHTML = state.sessions.map((session, index) => {
    const active = session.sessionId === state.activeSessionId ? "active" : "";
    const savings = savingsSummary(session);
    const cache = session.cacheAuditSummary && session.cacheAuditSummary.warmCandidates > 0
      ? '<span>C ' + fmtInt(session.cacheAuditSummary.warmHits) + '/' + fmtInt(session.cacheAuditSummary.warmCandidates) + '</span>'
      : '';
    return '<button class="session-item ' + active + '" data-session-id="' + escapeHtml(session.sessionId) + '" data-index="' + (index + 1) + '" type="button">'
      + '<div class="session-id">' + escapeHtml(session.sessionId) + '</div>'
      + '<div class="session-meta"><span>S ' + fmtInt(session.stabilityCount) + '</span><span>R ' + fmtInt(session.reductionCount) + '</span><span>E ' + fmtInt(session.evictionCount) + '</span>' + cache + (savings ? '<span>' + escapeHtml(savings) + '</span>' : '') + '<span>' + escapeHtml(fmtDate(session.lastAt)) + '</span></div>'
      + '</button>';
  }).join("");
  el.sessionList.querySelectorAll(".session-item").forEach((node) => {
    node.addEventListener("click", () => {
      void loadSession(node.getAttribute("data-session-id") || "");
    });
  });
}

function activeItems() {
  const data = state.sessionData.get((state.activeHost || "") + "::" + state.activeSessionId);
  if (!data) return [];
  if (state.activeTab === "stability") return data.stability || [];
  if (state.activeTab === "reduction") return data.reductionCalls || [];
  return data.eviction || [];
}

function renderEmpty(message) {
  el.panelTitle.textContent = state.activeSessionId || "No session selected";
  el.subtitle.textContent = message;
  el.panelMeta.innerHTML = "";
  el.pagerLabel.textContent = "0 / 0";
  el.prevBtn.disabled = true;
  el.nextBtn.disabled = true;
  el.stats.innerHTML = "";
  el.compareRoot.innerHTML = '<div class="empty">' + escapeHtml(message) + '</div>';
  el.passRoot.innerHTML = "";
}

async function setActiveHost(hostId) {
  if (state.activeHost && state.activeSessionId) {
    state.lastSessionByHost[state.activeHost] = state.activeSessionId;
  }
  state.activeHost = hostId || "";
  state.activeSessionId = "";
  state.sessions = [];
  state.reductionSegmentIndex = 0;
  state.reductionActiveCallKey = "";
  state.fingerprintGroupsExpanded = false;
  const query = new URL(window.location.href);
  if (state.activeHost) {
    query.searchParams.set("host", state.activeHost);
  } else {
    query.searchParams.delete("host");
  }
  query.searchParams.delete("session");
  query.searchParams.set("tab", state.activeTab);
  history.replaceState(null, "", query.toString());
  await loadSessions();
}

el.hostSelect.addEventListener("change", async () => {
  await setActiveHost(el.hostSelect.value || "");
});

function renderStability(item) {
  const data = state.sessionData.get((state.activeHost || "") + "::" + state.activeSessionId) || {};
  const cacheAuditSummary = data.cacheAuditSummary || null;
  const recentCacheAudit = data.recentCacheAudit || [];
  const recentCacheAuditGroups = data.recentCacheAuditGroups || [];
  const matchedCacheEntry = findMatchingCacheAuditEntry(item, recentCacheAudit);
  const matchedFingerprintGroup = findMatchingCacheAuditGroup(matchedCacheEntry, recentCacheAuditGroups);
  el.panelTitle.textContent = "Cache Stability";
  el.panelMeta.innerHTML = '<span>' + escapeHtml(fmtDate(item.at)) + '</span>'
    + '<span>target ' + escapeHtml(item.dynamicContextTarget) + '</span>'
    + '<span>model ' + escapeHtml(item.model || item.upstreamModel || "unknown") + '</span>';
  el.stats.innerHTML = [
    ["Cache key before", item.promptCacheKeyBefore || "-"],
    ["Cache key after", item.promptCacheKeyAfter || "-"],
    ["Matched fingerprint", matchedFingerprintGroup?.stablePrefixFingerprint || matchedCacheEntry?.stablePrefixFingerprint || "-"],
    ["User rewrites", fmtInt(item.userContentRewrites)],
    ["Sender blocks", fmtInt(item.senderMetadataBlocksBefore) + " -> " + fmtInt(item.senderMetadataBlocksAfter)],
    ["First turn candidate", String(Boolean(item.firstTurnCandidate))],
    ...(cacheAuditSummary
      ? [["Warm hit rate", fmtInt(cacheAuditSummary.warmHits || 0) + "/" + fmtInt(cacheAuditSummary.warmCandidates || 0) + " (" + String(cacheAuditSummary.hitRatePercent || 0) + "%)"]]
      : []),
  ].map(([label, value]) => '<div class="chip">' + escapeHtml(label) + ': ' + escapeHtml(value) + '</div>').join("");
  el.compareRoot.innerHTML = '<div class="pass-list">'
    + renderDiffBlock("Root Prompt -> Canonical", item.developerBefore, item.developerCanonical)
    + renderDiffBlock("Canonical -> Forwarded", item.developerCanonical, item.developerForwarded)
    + '</div>';
  const dynamicContextBlock = item.dynamicContextText
    ? '<div class="pass-list" style="margin-top:16px;">'
      + '<div class="diff-block"><div class="pane-label">Dynamic Context</div><pre>' + escapeHtml(item.dynamicContextText || "") + '</pre></div>'
      + '</div>'
    : "";
  el.passRoot.innerHTML =
    renderPromptCacheTransition(item, matchedCacheEntry, matchedFingerprintGroup, cacheAuditSummary)
    + renderStabilityContextPanels(item)
    + dynamicContextBlock
    + renderCacheAuditPanel(cacheAuditSummary)
    + renderCacheAuditFingerprintGroups(recentCacheAuditGroups)
    + renderCacheAuditRecentTable(recentCacheAudit);
  const toggleFingerprintGroupsBtn = document.getElementById("toggleFingerprintGroupsBtn");
  if (toggleFingerprintGroupsBtn) {
    toggleFingerprintGroupsBtn.addEventListener("click", () => {
      state.fingerprintGroupsExpanded = !state.fingerprintGroupsExpanded;
      renderActiveView();
    });
  }
}

function countModeMetaLabel(mode) {
  return mode === "chars" ? "chars fallback" : "precise OpenAI tokens";
}

function renderReduction(item) {
  const data = state.sessionData.get((state.activeHost || "") + "::" + state.activeSessionId) || {};
  const recentReduction = data.recentReduction || null;
  const uxAggregate = data.uxAggregate || null;
  const cacheAuditSummary = data.cacheAuditSummary || null;
  const recentCacheAudit = data.recentCacheAudit || [];
  const recentCacheAuditGroups = data.recentCacheAuditGroups || [];
  const segments = Array.isArray(item.segments) ? item.segments : [];
  const selectedSegment = syncReductionSegmentSelection(item);
  const selectedSegmentNumber = selectedSegment ? state.reductionSegmentIndex + 1 : 0;
  const passes = selectedSegment && Array.isArray(selectedSegment.report) ? selectedSegment.report : [];
  const changedPasses = passes.filter((entry) => entry && entry.changed);
  const toolSummary = Array.isArray(item.toolNames) && item.toolNames.length > 0 ? item.toolNames.join(", ") : "-";
  const routeSummary = Array.isArray(item.routes) && item.routes.length > 0 ? item.routes.join(", ") : "-";
  const pathSummary = Array.isArray(item.dataPaths) && item.dataPaths.length > 0 ? item.dataPaths.join(", ") : "-";
  const latestSegmentSummary = selectedSegment
    ? "latest segment #" + fmtInt(selectedSegmentNumber)
      + " · " + (selectedSegment.toolName || "-")
      + " · " + (selectedSegment.route || "-")
      + " · saved " + fmtInt(selectedSegment.savedChars)
    : "-";
  el.panelTitle.textContent = "Reduction Call";
  el.panelMeta.innerHTML = '<span>' + escapeHtml(fmtDate(item.at)) + '</span>'
    + '<span>request ' + escapeHtml(item.requestId) + '</span>'
    + '<span>segments ' + escapeHtml(fmtInt(item.segmentCount || 0)) + '</span>'
    + '<span>model ' + escapeHtml(item.model || item.upstreamModel || "unknown") + '</span>';
  el.stats.innerHTML = [
    ["Saved chars", fmtInt(item.totalSavedChars)],
    ["Segments", fmtInt(item.segmentCount)],
    ["Selected segment", selectedSegment ? fmtInt(selectedSegmentNumber) + " / " + fmtInt(segments.length) : "-"],
    ["Passes touched", fmtInt(changedPasses.length)],
    ["Tools", toolSummary],
    ["Routes", routeSummary],
    ["Paths", pathSummary],
    ["Latest segment", latestSegmentSummary],
    ...(uxAggregate && uxAggregate.latestCountMode
      ? [["Count mode", countModeMetaLabel(uxAggregate.latestCountMode)]]
      : []),
    ...(recentReduction && recentReduction.totalSavedChars > 0
      ? [["Recent total", fmtInt(recentReduction.totalSavedChars)]]
      : []),
    ...(recentReduction && recentReduction.dominantRoute
      ? [["Dominant route", recentReduction.dominantRoute.key + " (" + fmtInt(Math.round(Number(recentReduction.dominantRoute.sharePercent || 0))) + "%)"]]
      : []),
    ...(recentReduction && recentReduction.dominantPass
      ? [["Dominant pass", recentReduction.dominantPass.key]]
      : []),
  ].map(([label, value]) => '<div class="chip">' + escapeHtml(label) + ': ' + escapeHtml(value) + '</div>').join("");
  el.compareRoot.innerHTML = selectedSegment
    ? '<div class="compare">'
      + '<div class="pane"><div class="pane-label">Before Selected Segment</div><pre>' + escapeHtml(selectedSegment.beforeText) + '</pre></div>'
      + '<div class="pane"><div class="pane-label">After Selected Segment</div><pre>' + escapeHtml(selectedSegment.afterText) + '</pre></div>'
      + '</div>'
    : '<div class="empty">No reduction segments in this call.</div>';
  const segmentsHtml = segments.length === 0
    ? ""
    : '<div class="selector-layout">'
      + '<div><div class="selector-heading">Segments In This Call</div><div class="segment-list">'
      + segments.map((segment, index) => {
        const segmentPasses = Array.isArray(segment.report) ? segment.report.filter((entry) => entry && entry.changed) : [];
        const active = index === state.reductionSegmentIndex ? " active" : "";
        return '<button class="segment-btn' + active + '" data-segment-index="' + escapeHtml(String(index)) + '" type="button">'
          + '<strong>Segment #' + escapeHtml(String(index + 1)) + '</strong>'
          + (index === state.reductionSegmentIndex ? ' · selected' : '')
          + '<div class="segment-meta">'
          + 'saved=' + escapeHtml(fmtInt(segment.savedChars))
          + ' · field=' + escapeHtml(segment.field || "-")
          + ' · tool=' + escapeHtml(segment.toolName || "-")
          + '<br />segmentId=' + escapeHtml(segment.segmentId || "-")
          + ' · itemIndex=' + escapeHtml(fmtInt(segment.itemIndex))
          + (segment.dataPath ? ' · path=' + escapeHtml(segment.dataPath) : '')
          + (segment.route ? '<br />route=' + escapeHtml(segment.route) + (segment.routeReason ? ' · reason=' + escapeHtml(segment.routeReason) : '') : '')
          + '<br />changed passes=' + escapeHtml(fmtInt(segmentPasses.length))
          + '</div></button>';
      }).join("")
      + '</div></div>'
      + '</div>';
  const selectedSegmentDetails = !selectedSegment
    ? ""
    : '<div class="pass-list"><div class="pass-item"><strong>Selected Segment</strong>'
      + '<br />saved=' + escapeHtml(fmtInt(selectedSegment.savedChars))
      + ' · route=' + escapeHtml(selectedSegment.route || "-")
      + (selectedSegment.routeReason ? ' · reason=' + escapeHtml(selectedSegment.routeReason) : '')
      + '<br />field=' + escapeHtml(selectedSegment.field || "-")
      + ' · tool=' + escapeHtml(selectedSegment.toolName || "-")
      + (selectedSegment.dataPath ? ' · path=' + escapeHtml(selectedSegment.dataPath) : '')
      + '<br />segmentId=' + escapeHtml(selectedSegment.segmentId || "-")
      + ' · itemIndex=' + escapeHtml(fmtInt(selectedSegment.itemIndex))
      + '</div></div>';
  const passesHtml = passes.length === 0
    ? ""
    : '<div class="pass-list">' + passes.map((entry) => {
        const saved = Math.max(0, Number(entry.beforeChars || 0) - Number(entry.afterChars || 0));
        return '<div class="pass-item">'
          + '<strong>' + escapeHtml(entry.id || "pass") + '</strong>'
          + ' · ' + escapeHtml(entry.phase || "")
          + ' · ' + escapeHtml(entry.target || "")
          + '<br />changed=' + escapeHtml(String(Boolean(entry.changed)))
          + ' · saved=' + escapeHtml(fmtInt(saved))
          + (entry.note ? ' · note=' + escapeHtml(entry.note) : '')
          + (entry.skippedReason ? ' · skipped=' + escapeHtml(entry.skippedReason) : '')
          + '</div>';
      }).join("") + '</div>';
  el.passRoot.innerHTML =
    segmentsHtml
    + selectedSegmentDetails
    + passesHtml
    + renderCacheAuditPanel(cacheAuditSummary)
    + renderCacheAuditFingerprintGroups(recentCacheAuditGroups)
    + renderCacheAuditRecentTable(recentCacheAudit);
  el.passRoot.querySelectorAll("[data-segment-index]").forEach((node) => {
    node.addEventListener("click", () => {
      state.reductionSegmentIndex = Number(node.getAttribute("data-segment-index") || "0");
      renderActiveView();
    });
  });
  const toggleFingerprintGroupsBtn = document.getElementById("toggleFingerprintGroupsBtn");
  if (toggleFingerprintGroupsBtn) {
    toggleFingerprintGroupsBtn.addEventListener("click", () => {
      state.fingerprintGroupsExpanded = !state.fingerprintGroupsExpanded;
      renderActiveView();
    });
  }
}

function renderEviction(item) {
  const data = state.sessionData.get((state.activeHost || "") + "::" + state.activeSessionId) || {};
  const cacheAuditSummary = data.cacheAuditSummary || null;
  const recentCacheAudit = data.recentCacheAudit || [];
  const recentCacheAuditGroups = data.recentCacheAuditGroups || [];
  el.panelTitle.textContent = "Eviction";
  el.panelMeta.innerHTML = '<span>' + escapeHtml(fmtDate(item.at)) + '</span>'
    + '<span>task ' + escapeHtml(item.taskLabel || item.taskId) + '</span>'
    + '<span>' + escapeHtml(item.replacementMode) + '</span>';
  el.stats.innerHTML = [
    ["Before chars", fmtInt(item.beforeChars)],
    ["After chars", fmtInt(item.afterChars)],
    ["Task id", item.taskId],
    ["Turns", Array.isArray(item.turnAbsIds) ? fmtInt(item.turnAbsIds.length) : "0"],
  ].map(([label, value]) => '<div class="chip">' + escapeHtml(label) + ': ' + escapeHtml(value) + '</div>').join("");
  el.compareRoot.innerHTML = '<div class="compare">'
    + '<div class="pane"><div class="pane-label">Before Eviction</div><pre>' + escapeHtml(item.beforeText) + '</pre></div>'
    + '<div class="pane"><div class="pane-label">After Eviction</div><pre>' + escapeHtml(item.afterText) + '</pre></div>'
    + '</div>';
  const archiveBlock = item.archivePath
    ? '<div class="pass-list"><div class="pass-item"><strong>Archive</strong><br />' + escapeHtml(item.archivePath) + '</div></div>'
    : "";
  el.passRoot.innerHTML =
    archiveBlock
    + renderCacheAuditPanel(cacheAuditSummary)
    + renderCacheAuditFingerprintGroups(recentCacheAuditGroups)
    + renderCacheAuditRecentTable(recentCacheAudit);
  const toggleFingerprintGroupsBtn = document.getElementById("toggleFingerprintGroupsBtn");
  if (toggleFingerprintGroupsBtn) {
    toggleFingerprintGroupsBtn.addEventListener("click", () => {
      state.fingerprintGroupsExpanded = !state.fingerprintGroupsExpanded;
      renderActiveView();
    });
  }
}

function renderActiveView() {
  const query = new URL(window.location.href);
  query.searchParams.set("tab", state.activeTab);
  if (state.activeHost) {
    query.searchParams.set("host", state.activeHost);
  }
  if (state.activeSessionId) {
    query.searchParams.set("session", state.activeSessionId);
  }
  history.replaceState(null, "", query.toString());
  const items = activeItems();
  const index = state.indexes[state.activeTab] || 0;
  el.tabStability.classList.toggle("active", state.activeTab === "stability");
  el.tabReduction.classList.toggle("active", state.activeTab === "reduction");
  el.tabEviction.classList.toggle("active", state.activeTab === "eviction");
  if (!state.activeSessionId) {
    renderEmpty("Pick a session from the left.");
    return;
  }
  if (items.length === 0) {
    renderEmpty("This session has no " + state.activeTab + " snapshots yet.");
    return;
  }
  const safeIndex = Math.max(0, Math.min(index, items.length - 1));
  state.indexes[state.activeTab] = safeIndex;
  el.pagerLabel.textContent = (state.activeTab === "reduction" ? "Call " : "") + (safeIndex + 1) + " / " + items.length;
  el.prevBtn.disabled = safeIndex <= 0;
  el.nextBtn.disabled = safeIndex >= items.length - 1;
  const item = items[safeIndex];
  if (state.activeTab !== "reduction") {
    state.reductionSegmentIndex = 0;
    state.reductionActiveCallKey = "";
    state.fingerprintGroupsExpanded = false;
  }
  if (state.activeTab === "stability") {
    renderStability(item);
  } else if (state.activeTab === "reduction") {
    renderReduction(item);
  } else {
    renderEviction(item);
  }
}

el.tabStability.addEventListener("click", () => {
  state.activeTab = "stability";
  state.reductionSegmentIndex = 0;
  state.reductionActiveCallKey = "";
  state.fingerprintGroupsExpanded = false;
  renderActiveView();
});
el.tabReduction.addEventListener("click", () => {
  state.activeTab = "reduction";
  state.reductionSegmentIndex = 0;
  state.reductionActiveCallKey = "";
  state.fingerprintGroupsExpanded = false;
  renderActiveView();
});
el.tabEviction.addEventListener("click", () => {
  state.activeTab = "eviction";
  state.reductionSegmentIndex = 0;
  state.reductionActiveCallKey = "";
  state.fingerprintGroupsExpanded = false;
  renderActiveView();
});
el.prevBtn.addEventListener("click", () => {
  state.indexes[state.activeTab] = Math.max(0, (state.indexes[state.activeTab] || 0) - 1);
  renderActiveView();
});
el.nextBtn.addEventListener("click", () => {
  state.indexes[state.activeTab] = (state.indexes[state.activeTab] || 0) + 1;
  renderActiveView();
});
el.collapseBtn.addEventListener("click", () => {
  state.collapsed = !state.collapsed;
  el.app.classList.toggle("collapsed", state.collapsed);
  el.collapseBtn.textContent = state.collapsed ? "›" : "‹";
});

window.addEventListener("error", (event) => {
  const message = event?.error?.message || event?.message || "Unknown visual page error";
  renderEmpty("Visual page error: " + message);
});

window.addEventListener("popstate", () => {
  const query = new URL(window.location.href);
  state.activeHost = query.searchParams.get("host") || "";
  state.activeSessionId = query.searchParams.get("session") || "";
  state.activeTab = query.searchParams.get("tab") || "stability";
  state.reductionSegmentIndex = 0;
  state.reductionActiveCallKey = "";
  state.fingerprintGroupsExpanded = false;
  void loadSessions().catch((error) => {
    renderEmpty("Failed to load visual data: " + (error && error.message ? error.message : String(error)));
  });
});

void loadSessions().catch((error) => {
  renderEmpty("Failed to load visual data: " + (error && error.message ? error.message : String(error)));
});`;
}
