import { createServer } from "node:http";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { URL } from "node:url";

type EventTraceRow = {
  at?: string;
  logicalSessionId?: string;
  physicalSessionId?: string;
  provider?: string;
  model?: string;
  prompt?: string;
  responsePreview?: string;
  usage?: Record<string, unknown>;
  contextDetail?: Record<string, unknown>;
  resultEvents?: Array<{
    type?: string;
    payload?: Record<string, unknown>;
  }>;
};

type LlmHookRow = {
  at?: string;
  hook?: string;
  sessionKey?: string;
  event?: Record<string, unknown>;
};

type SessionOverview = {
  sessionId: string;
  updatedAt?: string;
  provider?: string;
  model?: string;
  turnCount?: number;
  summaryPreview?: string;
};

const port = Number(process.env.ECOCLAW_VIS_PORT ?? "7777");
const host = process.env.ECOCLAW_VIS_HOST ?? "127.0.0.1";
const stateDir = resolve(process.env.ECOCLAW_STATE_DIR ?? "/tmp/ecoclaw-plugin-state");
const rootDir = join(stateDir, "ecoclaw");
const sessionsDir = join(rootDir, "sessions");
const eventTracePath = process.env.ECOCLAW_EVENT_TRACE_PATH ?? join(rootDir, "event-trace.jsonl");
const llmHooksPath =
  process.env.ECOCLAW_LLM_HOOKS_PATH ??
  process.env.ECOCLAW_DEBUG_TAP_LLM_HOOKS_PATH ??
  "/tmp/ecoclaw-provider-traffic.llm-hooks.jsonl";

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>EcoClaw CacheTree Inspector</title>
  <style>
    :root {
      --bg:#f5f7f9;
      --panel:#ffffff;
      --ink:#1f2a33;
      --muted:#63707a;
      --line:#d8dee3;
      --edge:#b5c0c9;
      --alive:#3db76d;
      --alive-stroke:#2f8d54;
      --dead:#ffffff;
      --dead-stroke:#9ba7b2;
      --tip:#101a24;
    }
    * { box-sizing:border-box; }
    body {
      margin:0;
      font-family:"IBM Plex Sans","Noto Sans",sans-serif;
      color:var(--ink);
      background:radial-gradient(circle at 100% 0%, #e7eef4 0%, var(--bg) 45%);
    }
    .wrap { max-width:1500px; margin:18px auto 30px; padding:0 14px; }
    h1 { margin:0 0 6px; font-size:30px; }
    .sub { margin:0 0 12px; color:var(--muted); font-size:14px; }
    .card {
      background:var(--panel);
      border:1px solid var(--line);
      border-radius:14px;
      padding:12px;
      box-shadow:0 8px 20px rgba(20,35,50,.05);
      margin-bottom:12px;
    }
    .mono { font-family:"JetBrains Mono","Fira Code",monospace; font-size:12px; }
    .tiny { font-size:12px; color:var(--muted); }
    .toolbar {
      display:flex;
      gap:12px;
      align-items:center;
      flex-wrap:wrap;
      margin-bottom:8px;
    }
    .field { display:flex; align-items:center; gap:8px; font-size:12px; color:var(--muted); }
    .field select {
      border:1px solid var(--line);
      border-radius:8px;
      background:#fff;
      padding:6px 8px;
      min-width:230px;
      color:#24303a;
      font-size:12px;
    }
    .legend { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
    .dot { width:14px; height:14px; border-radius:50%; display:inline-block; border:2px solid var(--dead-stroke); }
    .alive { background:var(--alive); border-color:var(--alive-stroke); }
    .dead { background:var(--dead); border-color:var(--dead-stroke); }
    #branchWrap {
      display:flex;
      gap:8px;
      flex-wrap:wrap;
      margin-top:8px;
      margin-bottom:6px;
    }
    .branch-pill {
      border:1px solid #d2dae1;
      border-radius:999px;
      padding:4px 10px;
      font-size:12px;
      background:#f7fafc;
      cursor:pointer;
      user-select:none;
    }
    .branch-pill.off {
      opacity:.45;
      text-decoration:line-through;
    }
    .layout {
      display:grid;
      grid-template-columns: 1.2fr .8fr;
      gap:12px;
      min-height:560px;
    }
    @media (max-width: 1200px) {
      .layout { grid-template-columns: 1fr; }
    }
    #treeWrap {
      overflow:auto;
      border:1px solid var(--line);
      border-radius:12px;
      background:#fbfcfd;
      min-height:520px;
    }
    #tree { min-height:320px; min-width:980px; }
    #detail {
      border:1px solid var(--line);
      border-radius:12px;
      background:#fcfdff;
      padding:10px;
      min-height:520px;
    }
    #detail h3 { margin:0 0 8px; font-size:16px; }
    .kvline { font-size:12px; color:#44525e; margin-bottom:4px; }
    .box {
      border:1px solid #e6ebf0;
      border-radius:8px;
      background:#fff;
      padding:8px;
      margin-bottom:8px;
      font-size:12px;
      white-space:pre-wrap;
      word-break:break-word;
      overflow:auto;
    }
    .tooltip {
      position:fixed;
      z-index:20;
      display:none;
      max-width:520px;
      background:var(--tip);
      color:#e5eef7;
      border:1px solid #273444;
      border-radius:10px;
      padding:10px;
      font-size:12px;
      line-height:1.4;
      box-shadow:0 10px 24px rgba(0,0,0,.35);
      white-space:pre-wrap;
      pointer-events:none;
    }
    table { width:100%; border-collapse:collapse; font-size:12px; }
    th, td { text-align:left; border-bottom:1px solid #edf1f4; padding:6px 4px; }
    th { color:#4f5c67; }
    .empty-note { color:var(--muted); font-size:13px; margin-top:14px; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>EcoClaw CacheTree Inspector</h1>
    <p class="sub">Each turn is a node in a tree. Hover for quick info, click for full dialogue details.</p>

    <div class="card" id="meta"></div>

    <div class="card">
      <div class="toolbar">
        <div class="field">Logical Session
          <select id="sessionSelect"></select>
        </div>
        <div class="legend">
          <span><span class="dot alive"></span> cache valid</span>
          <span><span class="dot dead"></span> cache expired</span>
          <span><span class="mono">- - -</span> compaction lineage</span>
        </div>
      </div>
      <div id="branchWrap"></div>
      <div class="layout">
        <div id="treeWrap"><svg id="tree"></svg></div>
        <div id="detail">
          <h3>Turn Detail</h3>
          <div class="empty-note">Click a node to inspect this turn's full information.</div>
        </div>
      </div>
    </div>

    <div class="card">
      <h3 style="margin:0 0 8px">Persisted Sessions</h3>
      <div id="sessions"></div>
    </div>
  </div>

  <div id="tip" class="tooltip"></div>

  <script>
    var SVG_NS = "http://www.w3.org/2000/svg";
    var appState = {
      events: [],
      llmHooks: [],
      sessions: [],
      selectedLogical: "ALL",
      hiddenBranches: {},
      selectedNodeId: null
    };

    function fmtShort(iso) {
      if (!iso) return "-";
      var d = new Date(iso);
      if (isNaN(d.getTime())) return "-";
      return d.toLocaleString();
    }

    function resolveTurnReadTokens(node) {
      if (!node) return undefined;
      if (node.readTokens != null && isFinite(Number(node.readTokens))) return Number(node.readTokens);
      var usage = node.usage || {};
      if (usage.cacheReadTokens != null && isFinite(Number(usage.cacheReadTokens))) return Number(usage.cacheReadTokens);
      if (usage.cachedTokens != null && isFinite(Number(usage.cachedTokens))) return Number(usage.cachedTokens);
      return undefined;
    }

    function normalizeUsage(raw) {
      var src = raw || {};
      var u = {
        inputTokens: Number(src.input),
        outputTokens: Number(src.output),
        cacheReadTokens: Number(src.cacheRead),
      };
      if (!isFinite(u.inputTokens)) u.inputTokens = undefined;
      if (!isFinite(u.outputTokens)) u.outputTokens = undefined;
      if (!isFinite(u.cacheReadTokens)) u.cacheReadTokens = undefined;
      return u;
    }

    function ms(iso) {
      var t = Date.parse(iso || "");
      return isFinite(t) ? t : 0;
    }

    function plusMinutesIso(iso, minutes) {
      var base = ms(iso);
      if (!base) base = Date.now();
      return new Date(base + Math.max(0, Number(minutes || 0)) * 60000).toISOString();
    }

    function hashText(text) {
      var s = String(text || "");
      var h = 2166136261;
      for (var i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return (h >>> 0).toString(16);
    }

    function flattenText(v) {
      if (v == null) return "";
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
      if (Array.isArray(v)) {
        var out = [];
        for (var i = 0; i < v.length; i++) out.push(flattenText(v[i]));
        return out.join("\\n");
      }
      if (typeof v === "object") {
        if (typeof v.text === "string") return v.text;
        try { return JSON.stringify(v); } catch { return String(v); }
      }
      return String(v);
    }

    function msgSignature(msg) {
      var role = String((msg || {}).role || "-");
      var content = flattenText((msg || {}).content || "");
      return role + ":" + hashText(content);
    }

    function isStrictPrefix(a, b) {
      if (!Array.isArray(a) || !Array.isArray(b)) return false;
      if (a.length >= b.length) return false;
      for (var i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
      }
      return true;
    }

    function buildTraceIndex(events) {
      var byPrompt = {};
      for (var i = 0; i < events.length; i++) {
        var e = events[i] || {};
        var p = String(e.prompt || "");
        if (!p) continue;
        if (!byPrompt[p]) byPrompt[p] = [];
        byPrompt[p].push(e);
      }
      for (var k in byPrompt) {
        byPrompt[k].sort(function(a,b){ return ms(a.at) - ms(b.at); });
      }
      return byPrompt;
    }

    function findClosestTrace(byPrompt, prompt, atIso) {
      var list = byPrompt[String(prompt || "")];
      if (!list || !list.length) return null;
      var t = ms(atIso);
      var best = null;
      var bestGap = Infinity;
      for (var i = 0; i < list.length; i++) {
        var g = Math.abs(ms(list[i].at) - t);
        if (g < bestGap) { bestGap = g; best = list[i]; }
      }
      return { row: best, gapMs: bestGap };
    }

    function toNodes(events, llmHooks) {
      var hookRows = Array.isArray(llmHooks) ? llmHooks : [];
      var inputByRun = {};
      var outputByRun = {};
      for (var i = 0; i < hookRows.length; i++) {
        var r = hookRows[i] || {};
        var hook = String(r.hook || "");
        var runId = String(((r.event || {}).runId) || "");
        if (!runId) continue;
        if (hook === "llm_input") inputByRun[runId] = r;
        if (hook === "llm_output") outputByRun[runId] = r;
      }

      var byPrompt = buildTraceIndex(events || []);
      var turns = [];
      var runIds = Object.keys(inputByRun);
      for (var j = 0; j < runIds.length; j++) {
        var runId = runIds[j];
        var inp = inputByRun[runId];
        var out = outputByRun[runId];
        if (!inp || !out) continue;
        var iev = inp.event || {};
        var oev = out.event || {};
        var promptText = String(iev.prompt || "");
        var traceMatch = findClosestTrace(byPrompt, promptText, out.at || inp.at);
        var trace = null;
        if (traceMatch && traceMatch.row && traceMatch.gapMs <= 60000) trace = traceMatch.row;
        var usage = normalizeUsage((oev.lastAssistant || {}).usage || {});
        var hist = Array.isArray(iev.historyMessages) ? iev.historyMessages : [];
        var seq = [];
        for (var h = 0; h < hist.length; h++) seq.push(msgSignature(hist[h]));
        seq.push("user:" + hashText(promptText));
        var llmSessionId = String(iev.sessionId || "");
        var llmSessionKey = String(inp.sessionKey || "unknown");
        var logicalSessionId = llmSessionId || llmSessionKey || ((trace && trace.logicalSessionId) ? String(trace.logicalSessionId) : "unknown");
        var physicalSessionId = llmSessionId || llmSessionKey || ((trace && trace.physicalSessionId) ? String(trace.physicalSessionId) : "unknown");
        var systemPromptText = String(iev.systemPrompt || "");

        turns.push({
          id: "turn::" + runId,
          rawId: "run-" + String(runId).slice(0, 8),
          runId: runId,
          parentId: undefined,
          parentRawId: undefined,
          seq: seq,
          seqLen: seq.length,
          branch: "main",
          rootVersion: hashText(systemPromptText),
          sessionKey: llmSessionKey,
          sessionId: llmSessionId || "unknown",
          at: out.at || inp.at,
          expiresAt: plusMinutesIso(out.at || inp.at, 5),
          logicalSessionId: logicalSessionId,
          physicalSessionId: physicalSessionId,
          provider: String(oev.provider || iev.provider || (trace && trace.provider) || "-"),
          model: String(oev.model || iev.model || (trace && trace.model) || "-"),
          prompt: promptText,
          responsePreview: flattenText((oev.assistantTexts || [])[0] || ""),
          usage: usage,
          readTokens: usage.cacheReadTokens,
          contextDetail: {
            finalContext:
              trace && trace.contextDetail && typeof trace.contextDetail === "object"
                ? ((trace.contextDetail as Record<string, unknown>).finalContext as Record<string, unknown> | undefined)
                : undefined,
            requestDetail: {
              renderedPromptText: promptText,
              metadata: {
                openclawPromptRoot: String(iev.systemPrompt || ""),
                runId: runId,
                sessionKey: String(inp.sessionKey || "unknown"),
                historyCount: hist.length,
                systemPromptChars: systemPromptText.length,
                userPromptChars: promptText.length,
                parentReason: "",
              },
            },
          },
          isSyntheticRoot: false,
          rootKind: "",
          linkFromId: undefined,
        });
      }

      turns.sort(function(a,b){ return ms(a.at) - ms(b.at); });

      var bySession = {};
      for (var t = 0; t < turns.length; t++) {
        var sk = turns[t].sessionKey || "unknown";
        if (!bySession[sk]) bySession[sk] = [];
        bySession[sk].push(turns[t]);
      }

      for (var skey in bySession) {
        var list = bySession[skey];
        for (var x = 0; x < list.length; x++) {
          var cur = list[x];
          cur.branch = "r-" + String(cur.rootVersion).slice(0, 8);
        }
      }

      var roots = [];
      var rootByGroup = {};
      var nodes = turns.slice();
      for (var n = 0; n < nodes.length; n++) {
        var node = nodes[n];
        var groupKey = (node.logicalSessionId || "unknown") + "::" + (node.sessionKey || "unknown") + "::" + String(node.rootVersion);
        var rootId = "root::" + groupKey;
        if (!rootByGroup[groupKey]) {
          rootByGroup[groupKey] = rootId;
          roots.push({
            id: rootId,
            rawId: "root-" + String(node.rootVersion).slice(0, 8),
            parentId: undefined,
            parentRawId: undefined,
            branch: node.branch,
            expiresAt: plusMinutesIso(node.at, 5),
            at: node.at,
            logicalSessionId: node.logicalSessionId,
            physicalSessionId: node.physicalSessionId,
            provider: node.provider,
            model: node.model,
            prompt: "",
            responsePreview: "",
            usage: {},
            readTokens: undefined,
            contextDetail: {
              openclawPromptRoot: String((((node.contextDetail || {}).requestDetail || {}).metadata || {}).openclawPromptRoot || ""),
              requestDetail: { metadata: { parentReason: "root-version" } },
            },
            isSyntheticRoot: true,
            rootKind: "session",
            linkFromId: undefined,
          });
        }
      }

      var byGroup = {};
      for (var y = 0; y < nodes.length; y++) {
        var no = nodes[y];
        var gk = (no.logicalSessionId || "unknown") + "::" + (no.sessionKey || "unknown") + "::" + String(no.rootVersion);
        if (!byGroup[gk]) byGroup[gk] = [];
        byGroup[gk].push(no);
      }

      for (var g in byGroup) {
        var arr = byGroup[g];
        arr.sort(function(a,b){ return ms(a.at) - ms(b.at); });
        for (var ii = 0; ii < arr.length; ii++) {
          var curNode = arr[ii];
          var best = null;
          var bestLen = -1;
          for (var jj = 0; jj < ii; jj++) {
            var cand = arr[jj];
            if (isStrictPrefix(cand.seq, curNode.seq) && cand.seq.length > bestLen) {
              best = cand;
              bestLen = cand.seq.length;
            }
          }
          if (best) {
            curNode.parentId = best.id;
            curNode.contextDetail.requestDetail.metadata.parentReason = "strict-prefix:" + String(best.rawId);
          } else {
            curNode.parentId = rootByGroup[g];
            curNode.contextDetail.requestDetail.metadata.parentReason = "root-fallback(no-prefix-parent)";
          }
        }
      }

      var out = roots.concat(nodes);
      out.sort(function(a,b){ return ms(a.at) - ms(b.at); });
      return out;
    }

    function buildDepth(nodes) {
      var byId = {};
      var depth = {};
      for (var i = 0; i < nodes.length; i++) byId[nodes[i].id] = nodes[i];

      function d(id, seen) {
        if (!id) return 0;
        if (typeof depth[id] === "number") return depth[id];
        if (seen[id]) return 0;
        seen[id] = true;
        var node = byId[id];
        if (!node) return 0;
        var v = node.parentId ? d(node.parentId, seen) + 1 : 0;
        depth[id] = v;
        return v;
      }

      for (var j = 0; j < nodes.length; j++) d(nodes[j].id, {});
      return depth;
    }

    function getLogicalSet(nodes) {
      var s = {};
      for (var i = 0; i < nodes.length; i++) s[nodes[i].logicalSessionId || "unknown"] = true;
      return Object.keys(s).sort();
    }

    function getBranchSet(nodes) {
      var s = {};
      for (var i = 0; i < nodes.length; i++) s[nodes[i].branch || "main"] = true;
      return Object.keys(s).sort();
    }

    function filterNodes(allNodes) {
      var selected = appState.selectedLogical;
      var out = [];
      for (var i = 0; i < allNodes.length; i++) {
        var n = allNodes[i];
        if (selected !== "ALL" && n.logicalSessionId !== selected) continue;
        if (appState.hiddenBranches[n.branch]) continue;
        out.push(n);
      }
      var byId = {};
      for (var j = 0; j < out.length; j++) byId[out[j].id] = true;
      for (var k = 0; k < out.length; k++) {
        if (out[k].parentId && !byId[out[k].parentId]) out[k].parentId = undefined;
      }
      return out;
    }

    function renderMeta(allNodes) {
      var meta = document.getElementById("meta");
      var now = Date.now();
      var alive = 0;
      for (var i = 0; i < allNodes.length; i++) {
        if (ms(allNodes[i].expiresAt) > now) alive++;
      }
      var logicalCount = getLogicalSet(allNodes).length;
      meta.innerHTML =
        '<div class="tiny">stateRoot: <span class="mono">' + window.__PATHS.rootDir + '</span></div>' +
        '<div class="tiny">eventTrace: <span class="mono">' + window.__PATHS.eventTracePath + '</span></div>' +
        '<div class="tiny">llmHooks: <span class="mono">' + (window.__PATHS.llmHooksPath || '-') + '</span></div>' +
        '<div style="margin-top:6px" class="tiny">turn nodes: <b>' + allNodes.length + '</b> | logical sessions: <b>' + logicalCount + '</b> | alive: <b style="color:#2d8d50">' + alive + '</b> | expired: <b>' + (allNodes.length - alive) + '</b></div>';
    }

    function renderSessionSelect(allNodes) {
      var select = document.getElementById("sessionSelect");
      var list = getLogicalSet(allNodes);
      var opts = ['<option value="ALL">ALL logical sessions</option>'];
      for (var i = 0; i < list.length; i++) {
        var id = list[i];
        var selectedAttr = appState.selectedLogical === id ? ' selected' : '';
        opts.push('<option value="' + id + '"' + selectedAttr + '>' + id + '</option>');
      }
      select.innerHTML = opts.join("");
      select.value = appState.selectedLogical;
      select.onchange = function() {
        appState.selectedLogical = select.value;
        appState.selectedNodeId = null;
        renderAll();
      };
    }

    function renderBranchPills(nodes) {
      var wrap = document.getElementById("branchWrap");
      var branches = getBranchSet(nodes);
      if (!branches.length) {
        wrap.innerHTML = '<span class="tiny">No branch data.</span>';
        return;
      }
      var html = '';
      for (var i = 0; i < branches.length; i++) {
        var b = branches[i];
        var off = !!appState.hiddenBranches[b];
        html += '<span class="branch-pill' + (off ? ' off' : '') + '" data-branch="' + b + '">' + b + '</span>';
      }
      wrap.innerHTML = html;
      var pills = wrap.querySelectorAll('.branch-pill');
      for (var j = 0; j < pills.length; j++) {
        pills[j].onclick = function() {
          var b = this.getAttribute('data-branch');
          appState.hiddenBranches[b] = !appState.hiddenBranches[b];
          appState.selectedNodeId = null;
          renderAll();
        };
      }
    }

    function nodeTooltipText(n) {
      var usage = n.usage || {};
      var policy = (((n.contextDetail || {}).finalContext || {}).metadata || {}).policy || {};
      var probe = policy.cacheProbe || {};
      var msg = '';
      msg += 'node: ' + (n.rawId || n.id) + '\\n';
      msg += 'parent: ' + (n.parentId || '(root)') + '\\n';
      msg += 'branch: ' + n.branch + '\\n';
      msg += 'logical: ' + (n.logicalSessionId || '-') + '\\n';
      msg += 'physical: ' + (n.physicalSessionId || '-') + '\\n';
      msg += 'provider/model: ' + (n.provider || '-') + '/' + (n.model || '-') + '\\n';
      msg += 'at: ' + fmtShort(n.at) + '\\n';
      msg += 'expiresAt: ' + fmtShort(n.expiresAt) + '\\n';
      if (n.isSyntheticRoot) {
        msg += 'type: ' + (n.rootKind === "checkpoint" ? "CHECKPOINT ROOT" : "PROMPT ROOT") + '\\n';
        if (n.rootKind === "checkpoint" && n.linkFromId) {
          msg += 'from: ' + n.linkFromId + '\\n';
        }
        return msg;
      }
      msg += 'cacheRead: ' + (resolveTurnReadTokens(n) != null ? resolveTurnReadTokens(n) : '-') + '\\n';
      msg += 'input/output: ' + (usage.inputTokens != null ? usage.inputTokens : '-') + '/' + (usage.outputTokens != null ? usage.outputTokens : '-') + '\\n';
      if (probe && typeof probe === "object" && Object.keys(probe).length > 0) {
        msg += 'probe: mode=' + String(probe.mode || '-') + ' due=' + String(!!probe.probeDue) + ' planned=' + String(!!probe.probePlanned) + '\\n';
      }
      return msg;
    }

    function renderTree(nodes) {
      var svg = document.getElementById('tree');
      var tip = document.getElementById('tip');
      while (svg.firstChild) svg.removeChild(svg.firstChild);

      if (!nodes.length) {
        var t = document.createElementNS(SVG_NS, 'text');
        t.setAttribute('x', '20');
        t.setAttribute('y', '40');
        t.setAttribute('fill', '#63707a');
        t.textContent = 'No nodes under current filter.';
        svg.appendChild(t);
        svg.setAttribute('width', '980');
        svg.setAttribute('height', '120');
        return;
      }

      var depth = buildDepth(nodes);
      var xGap = 145, laneGap = 120, rowGap = 42, x0 = 70, y0 = 48;
      function laneKey(n) {
        var logical = n.logicalSessionId || "unknown";
        if (n.isSyntheticRoot) {
          if (n.rootKind === "checkpoint") return logical + "::checkpoint::" + String(n.branch || "main");
          return logical + "::prompt-root";
        }
        return logical + "::branch::" + String(n.branch || "main");
      }
      var laneSeen = {};
      var lanes = [];
      for (var li = 0; li < nodes.length; li++) {
        var lk = laneKey(nodes[li]);
        if (laneSeen[lk]) continue;
        laneSeen[lk] = true;
        lanes.push(lk);
      }
      var laneIndex = {};
      for (var lx = 0; lx < lanes.length; lx++) laneIndex[lanes[lx]] = lx;
      var laneRow = {};
      var pos = {}, maxX = 0, maxY = 0;
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        var x = x0 + (depth[n.id] || 0) * xGap;
        var lane = laneKey(n);
        var lidx = laneIndex[lane] || 0;
        var lrow = laneRow[lane] || 0;
        var y = y0 + lidx * laneGap + lrow * rowGap;
        laneRow[lane] = lrow + 1;
        pos[n.id] = { x:x, y:y };
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      svg.setAttribute('width', String(maxX + 260));
      svg.setAttribute('height', String(maxY + 130));

      for (var e = 0; e < nodes.length; e++) {
        var c = nodes[e];
        if (!c.parentId || !pos[c.parentId]) continue;
        var p1 = pos[c.parentId], p2 = pos[c.id];
        var line = document.createElementNS(SVG_NS, 'line');
        line.setAttribute('x1', String(p1.x));
        line.setAttribute('y1', String(p1.y));
        line.setAttribute('x2', String(p2.x));
        line.setAttribute('y2', String(p2.y));
        line.setAttribute('stroke', '#b5c0c9');
        line.setAttribute('stroke-width', '1.5');
        svg.appendChild(line);
      }

      for (var ex = 0; ex < nodes.length; ex++) {
        var n2 = nodes[ex];
        if (!n2.linkFromId || !pos[n2.linkFromId] || !pos[n2.id]) continue;
        var s1 = pos[n2.linkFromId], s2 = pos[n2.id];
        var hint = document.createElementNS(SVG_NS, 'line');
        hint.setAttribute('x1', String(s1.x));
        hint.setAttribute('y1', String(s1.y));
        hint.setAttribute('x2', String(s2.x));
        hint.setAttribute('y2', String(s2.y));
        hint.setAttribute('stroke', '#c97a1e');
        hint.setAttribute('stroke-width', '2');
        hint.setAttribute('stroke-dasharray', '6 4');
        svg.appendChild(hint);
      }

      for (var k = 0; k < nodes.length; k++) {
        (function(n){
          var p = pos[n.id];
          var alive = ms(n.expiresAt) > Date.now();
          var selected = appState.selectedNodeId === n.id;

          var g = document.createElementNS(SVG_NS, 'g');
          g.style.cursor = 'pointer';

          var circle = document.createElementNS(SVG_NS, 'circle');
          circle.setAttribute('cx', String(p.x));
          circle.setAttribute('cy', String(p.y));
          circle.setAttribute('r', selected ? '13' : '11');
          circle.setAttribute('fill', alive ? '#3db76d' : '#ffffff');
          circle.setAttribute('stroke', selected ? '#0f5f83' : (alive ? '#2f8d54' : '#9ba7b2'));
          circle.setAttribute('stroke-width', selected ? '3' : '2');

          var label = document.createElementNS(SVG_NS, 'text');
          label.setAttribute('x', String(p.x + 18));
          label.setAttribute('y', String(p.y + 4));
          label.setAttribute('fill', '#2d3740');
          label.setAttribute('font-size', '12');
          label.textContent = (n.rawId || n.id) + ' [' + n.branch + ']';

          var sub = document.createElementNS(SVG_NS, 'text');
          sub.setAttribute('x', String(p.x + 18));
          sub.setAttribute('y', String(p.y + 20));
          sub.setAttribute('fill', '#6a7782');
          sub.setAttribute('font-size', '11');
          var sRead = resolveTurnReadTokens(n);
          sub.textContent = n.isSyntheticRoot
            ? ((n.rootKind === "checkpoint" ? 'CHECKPOINT ROOT' : 'PROMPT ROOT') + ' · ' + fmtShort(n.at))
            : (fmtShort(n.at) + ' read=' + (sRead != null ? sRead : '-'));

          g.appendChild(circle);
          g.appendChild(label);
          g.appendChild(sub);

          g.addEventListener('mousemove', function(evt){
            tip.textContent = nodeTooltipText(n);
            tip.style.display = 'block';
            tip.style.left = (evt.clientX + 14) + 'px';
            tip.style.top = (evt.clientY + 14) + 'px';
          });
          g.addEventListener('mouseleave', function(){ tip.style.display = 'none'; });
          g.addEventListener('click', function(){
            appState.selectedNodeId = n.id;
            renderAll();
          });

          svg.appendChild(g);
        })(nodes[k]);
      }
    }

    function renderDetail(nodes) {
      var panel = document.getElementById('detail');
      var node = null;
      var byId = {};
      for (var bi = 0; bi < nodes.length; bi++) byId[nodes[bi].id] = nodes[bi];
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].id === appState.selectedNodeId) {
          node = nodes[i];
          break;
        }
      }
      if (!node) {
        panel.innerHTML = '<h3>Turn Detail</h3><div class="empty-note">Click a node to inspect this turn\\'s full information.</div>';
        return;
      }
      var usage = node.usage || {};
      var nodeTurnRead = resolveTurnReadTokens(node);
      var usageInput = (usage.inputTokens != null && isFinite(Number(usage.inputTokens))) ? Number(usage.inputTokens) : undefined;
      var usageOutput = (usage.outputTokens != null && isFinite(Number(usage.outputTokens))) ? Number(usage.outputTokens) : undefined;
      var ctxDetail = node.contextDetail || {};
      var req = ctxDetail.requestDetail || {};
      var finalCtx = ctxDetail.finalContext || {};
      var finalMeta = finalCtx.metadata || {};
      var policyMeta = finalMeta.policy || {};
      var probeMeta = policyMeta.cacheProbe || {};
      var policyReasons = Array.isArray(policyMeta.reasons) ? policyMeta.reasons : [];
      var reqMeta = req.metadata || {};
      var historyCount = (reqMeta.historyCount != null && isFinite(Number(reqMeta.historyCount))) ? Number(reqMeta.historyCount) : undefined;
      var systemPromptChars = (reqMeta.systemPromptChars != null && isFinite(Number(reqMeta.systemPromptChars))) ? Number(reqMeta.systemPromptChars) : undefined;
      var userPromptChars = (reqMeta.userPromptChars != null && isFinite(Number(reqMeta.userPromptChars))) ? Number(reqMeta.userPromptChars) : undefined;
      var reqSegments = Array.isArray(req.segments) ? req.segments : [];
      var isRoot = !node.parentId;
      var rootParts = [];
      for (var si = 0; si < reqSegments.length; si++) {
        var seg = reqSegments[si] || {};
        var kind = String(seg.kind || "");
        if (kind === "volatile") continue;
        var head = '[' + kind + '|p' + String(seg.priority != null ? seg.priority : '-') + '|' + String(seg.id || '-') + ']';
        var src = seg.source ? (' (' + String(seg.source) + ')') : '';
        var txt = String(seg.text || '');
        rootParts.push(head + src + '\\n' + txt);
      }
      var rootPromptText = rootParts.join('\\n\\n');
      var openclawPromptRoot = String(ctxDetail.openclawPromptRoot || finalMeta.openclawPromptRoot || '');
      if (openclawPromptRoot) rootPromptText = openclawPromptRoot;
      var renderedPromptText = String(req.renderedPromptText || '');
      var toolText = '';
      var msgTools = ctxDetail.turnTools || finalMeta.turnTools;
      if (Array.isArray(msgTools) && msgTools.length) {
        toolText = msgTools.map(function(x){ return String(x || ''); }).join('\\n\\n');
      } else {
        toolText = '(none)';
      }
      panel.innerHTML =
        '<h3>' + (node.rawId || node.id) + '</h3>' +
        '<div class="kvline">branch: <span class="mono">' + node.branch + '</span></div>' +
        '<div class="kvline">logical: <span class="mono">' + (node.logicalSessionId || '-') + '</span></div>' +
        '<div class="kvline">physical: <span class="mono">' + (node.physicalSessionId || '-') + '</span></div>' +
        '<div class="kvline">provider/model: <span class="mono">' + (node.provider || '-') + '/' + (node.model || '-') + '</span></div>' +
        '<div class="kvline">at: <span class="mono">' + fmtShort(node.at) + '</span></div>' +
        '<div class="kvline">expiresAt: <span class="mono">' + fmtShort(node.expiresAt) + '</span></div>' +
        '<div class="kvline">usage: prompt/completion/cacheRead = <span class="mono">' + (usageInput != null ? usageInput : '-') + '/' + (usageOutput != null ? usageOutput : '-') + '/' + (nodeTurnRead != null ? nodeTurnRead : '-') + '</span></div>' +
        '<div class="kvline">provider usage source: <span class="mono">llm_output.lastAssistant.usage</span></div>' +
        '<div class="kvline">llm input stats: historyCount/systemChars/userPromptChars = <span class="mono">' + (historyCount != null ? historyCount : '-') + '/' + (systemPromptChars != null ? systemPromptChars : '-') + '/' + (userPromptChars != null ? userPromptChars : '-') + '</span></div>' +
        '<div class="kvline">policy: shouldRequestSummary/reasons = <span class="mono">' + String(!!policyMeta.shouldRequestSummary) + ' / ' + (policyReasons.length ? policyReasons.join(",") : '-') + '</span></div>' +
        '<div class="kvline">probe: mode/due/planned = <span class="mono">' + String(probeMeta.mode || '-') + ' / ' + String(!!probeMeta.probeDue) + ' / ' + String(!!probeMeta.probePlanned) + '</span></div>' +
        '<div class="kvline">probe: lastRead/misses/hitMin = <span class="mono">' + String(probeMeta.lastProbeReadTokens != null ? probeMeta.lastProbeReadTokens : '-') + ' / ' + String(probeMeta.consecutiveProbeMisses != null ? probeMeta.consecutiveProbeMisses : '-') + ' / ' + String(probeMeta.probeHitMinTokens != null ? probeMeta.probeHitMinTokens : '-') + '</span></div>' +
        (
          node.isSyntheticRoot
            ? (
              (
                node.rootKind === "checkpoint"
                  ? (
                    '<div class="kvline" style="margin-top:8px">CHECKPOINT ROOT (compaction branch)</div>' +
                    '<div class="box mono">branch=' + String(node.branch || '-') + '\\nsource=' + String(node.linkFromId || '(unknown)') + '\\nsummaryChars=' + String(node.summaryChars != null ? node.summaryChars : '-') + '\\ncompactionTurn(prompt/completion/cacheRead)=' + String(usage.inputTokens != null ? usage.inputTokens : '-') + '/' + String(usage.outputTokens != null ? usage.outputTokens : '-') + '/' + String((nodeTurnRead != null ? nodeTurnRead : '-'))
                    + '</div>' +
                    '<div class="kvline">COMPACTION SOURCE USER</div>' +
                    '<div class="box">' + String((ctxDetail.checkpointSourceUser || '(empty)')) + '</div>' +
                    '<div class="kvline">COMPACTION SOURCE ASSISTANT</div>' +
                    '<div class="box">' + String((ctxDetail.checkpointSourceAssistant || '(empty)')) + '</div>' +
                    '<div class="kvline">SUMMARY GENERATED</div>' +
                    '<div class="box">' + String((ctxDetail.checkpointSummaryText || '(empty)')) + '</div>'
                  )
                  : (
                    '<div class="kvline" style="margin-top:8px">PROMPT ROOT (stable/system)</div>' +
                    '<div class="box mono">' + String(ctxDetail.openclawPromptRoot || rootPromptText || '(empty)') + '</div>'
                  )
              )
            )
            : (
              (isRoot
                ? (
                  '<div class="kvline" style="margin-top:8px">PROMPT ROOT (stable/system)</div>' +
                  '<div class="box mono">' + rootPromptText + '</div>' +
                  '<div class="kvline">RENDERED PROMPT (sent to LLM)</div>' +
                  '<div class="box mono">' + renderedPromptText + '</div>'
                )
                : ''
              ) +
              '<div class="kvline" style="margin-top:8px">USER</div>' +
              '<div class="box">' + String(node.prompt || '') + '</div>' +
              '<div class="kvline">ASSISTANT</div>' +
              '<div class="box">' + String(node.responsePreview || '') + '</div>' +
              '<div class="kvline">TOOL</div>' +
              '<div class="box">' + toolText + '</div>'
            )
        );
    }

    function renderSessionsTable(sessions) {
      var el = document.getElementById('sessions');
      sessions = Array.isArray(sessions) ? sessions.slice() : [];
      if (!sessions.length) {
        el.innerHTML = '<div class="tiny">No persisted sessions found.</div>';
        return;
      }
      sessions.sort(function(a,b){ return String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')); });
      sessions = sessions.slice(0, 40);
      var rows = '';
      for (var i = 0; i < sessions.length; i++) {
        var s = sessions[i];
        rows += '<tr>';
        rows += '<td class="mono">' + (s.sessionId || '') + '</td>';
        rows += '<td>' + (s.provider || '-') + '/' + (s.model || '-') + '</td>';
        rows += '<td>' + (s.turnCount != null ? s.turnCount : '-') + '</td>';
        rows += '<td class="mono">' + (s.updatedAt || '-') + '</td>';
        rows += '<td>' + (s.summaryPreview || '') + '</td>';
        rows += '</tr>';
      }
      el.innerHTML =
        '<table><thead><tr>' +
        '<th>session</th><th>provider/model</th><th>turns</th><th>updatedAt</th><th>summary</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table>';
    }

    function renderAll() {
      var allNodes = toNodes(appState.events || [], appState.llmHooks || []);
      renderMeta(allNodes);
      renderSessionSelect(allNodes);
      var filtered = filterNodes(allNodes);
      renderBranchPills(filtered);
      filtered = filterNodes(allNodes);
      renderTree(filtered);
      renderDetail(filtered);
      renderSessionsTable(appState.sessions || []);
    }

    async function refresh() {
      var resp = await fetch('/api/state');
      var data = await resp.json();
      window.__PATHS = data.paths || {};
      appState.events = data.events || [];
      appState.llmHooks = data.llmHooks || [];
      appState.sessions = data.sessions || [];
      renderAll();
    }

    refresh().catch(console.error);
    setInterval(function(){ refresh().catch(console.error); }, 5000);
  </script>
</body>
</html>`;

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function readEventTraceRows(): Promise<EventTraceRow[]> {
  try {
    const raw = await readFile(eventTracePath, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as EventTraceRow;
        } catch {
          return {} as EventTraceRow;
        }
      })
      .filter((row) => Object.keys(row).length > 0);
  } catch {
    return [];
  }
}

async function readLlmHookRows(): Promise<LlmHookRow[]> {
  try {
    const raw = await readFile(llmHooksPath, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as LlmHookRow;
        } catch {
          return {} as LlmHookRow;
        }
      })
      .filter((row) => Object.keys(row).length > 0)
      .slice(-5000);
  } catch {
    return [];
  }
}

async function readSessions(): Promise<SessionOverview[]> {
  try {
    const children = await readdir(sessionsDir);
    const rows: SessionOverview[] = [];
    for (const child of children) {
      const sessionDir = join(sessionsDir, child);
      const s = await stat(sessionDir).catch(() => null);
      if (!s?.isDirectory()) continue;
      const meta = await readJsonFile<Record<string, unknown>>(join(sessionDir, "meta.json"));
      const summary = await readJsonFile<Record<string, unknown>>(join(sessionDir, "summary.json"));
      rows.push({
        sessionId: String(meta?.sessionId ?? child),
        updatedAt: typeof meta?.updatedAt === "string" ? meta.updatedAt : undefined,
        provider: typeof meta?.provider === "string" ? meta.provider : undefined,
        model: typeof meta?.model === "string" ? meta.model : undefined,
        turnCount: typeof meta?.turnCount === "number" ? meta.turnCount : undefined,
        summaryPreview:
          typeof summary?.summary === "string"
            ? String(summary.summary).replace(/\s+/g, " ")
            : undefined,
      });
    }
    return rows;
  } catch {
    return [];
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/api/state") {
    const [events, llmHooks, sessions] = await Promise.all([readEventTraceRows(), readLlmHookRows(), readSessions()]);
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify(
        {
          paths: {
            stateDir,
            rootDir,
            sessionsDir,
            eventTracePath,
            llmHooksPath,
          },
          events,
          llmHooks,
          sessions,
        },
        null,
        2,
      ),
    );
    return;
  }

  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
});

server.listen(port, host, () => {
  console.log(`[ecoclaw-cachetree-web] listening on http://${host}:${port}`);
  console.log(`[ecoclaw-cachetree-web] stateDir=${stateDir}`);
  console.log(`[ecoclaw-cachetree-web] eventTrace=${eventTracePath}`);
  console.log(`[ecoclaw-cachetree-web] llmHooks=${llmHooksPath}`);
});
