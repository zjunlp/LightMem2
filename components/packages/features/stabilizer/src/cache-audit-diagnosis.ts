import type {
  StablePrefixDriftReason,
  StablePrefixEntropyFinding,
} from "./stable-prefix-audit.js";

export type CacheAuditDiagnosisInput = {
  stablePrefixFingerprint?: string | null;
  requestPromptCacheKey?: string | null;
  responsePromptCacheKey?: string | null;
  cachedInputTokens?: number | null;
  baselineKind?: "identity" | "request_key" | "session" | "none" | null;
  entropyFindings?: StablePrefixEntropyFinding[] | null;
  driftReasons?: StablePrefixDriftReason[] | null;
};

export type CacheAuditKiller = {
  title: string;
  fix: string;
  detail: string;
};

export type CacheAuditDiagnosis = {
  matchedResult: "warm hit" | "cold miss" | "cold start" | "unmatched";
  rewriteDetected: boolean;
  currentState: string;
  targetState: string;
  optimizationHint: string;
  killers: CacheAuditKiller[];
  harnessRules: string[];
};

function stableUniqueByKey<T>(items: T[], keyFn: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function buildOptimizationHint(params: {
  matchedResult: CacheAuditDiagnosis["matchedResult"];
  rewriteDetected: boolean;
  baselineKind: NonNullable<CacheAuditDiagnosisInput["baselineKind"]>;
  entropyFindings: StablePrefixEntropyFinding[];
  driftReasons: StablePrefixDriftReason[];
}): string {
  const { matchedResult, rewriteDetected, baselineKind, entropyFindings, driftReasons } = params;
  const entropyKinds = entropyFindings.map((item) => item.kind);
  if (matchedResult === "warm hit") {
    return "Warm hit: keep this prefix shape stable and watch for new drift or entropy spikes before changing sanitization.";
  }
  if (matchedResult === "cold start") {
    return baselineKind === "session"
      ? "Session-local cold start: this request family has no same-target warm baseline yet, so compare against adjacent same-key turns before treating it as drift."
      : "Cold start: capture one adjacent request for the same target before treating this as a real warm-cache miss.";
  }
  if (driftReasons.length > 0) {
    if (baselineKind === "session") {
      return "Session-local change: this differs from a nearby request in the same session, but it is not yet proven to be a same-target warm-cache miss.";
    }
    return "Fingerprint drift: move volatile prompt fragments out of stable prefix, or shift them into dynamic context before the next request.";
  }
  if (entropyKinds.includes("abs_path")) {
    return "Absolute-path entropy: strengthen path canonicalization so stable prefix keeps placeholders instead of host-specific filesystem paths.";
  }
  if (
    entropyKinds.includes("uuid")
    || entropyKinds.includes("timestamp")
    || entropyKinds.includes("long_number")
  ) {
    return "Runtime-ID entropy: strip timestamps, UUIDs, or long numeric identifiers out of stable prefix and keep them in dynamic context only.";
  }
  if (rewriteDetected) {
    return "Response key rewrite only: treat this as an observability signal first; optimize request-side prefix stability before reacting to response key churn.";
  }
  if (matchedResult === "cold miss") {
    return "Cold miss without obvious drift: compare this request against the previous fingerprint group and check for subtle tool or prompt-structure changes.";
  }
  return "No matching cache audit entry: expand observability coverage first, then re-check whether this stability snapshot lines up with a request-side cache record.";
}

function describeCurrentState(params: {
  matchedResult: CacheAuditDiagnosis["matchedResult"];
  rewriteDetected: boolean;
  baselineKind: NonNullable<CacheAuditDiagnosisInput["baselineKind"]>;
  entropyFindings: StablePrefixEntropyFinding[];
  driftReasons: StablePrefixDriftReason[];
}): string {
  const { matchedResult, rewriteDetected, baselineKind, entropyFindings, driftReasons } = params;
  const entropyKinds = entropyFindings.map((item) => item.kind);
  if (matchedResult === "warm hit") {
    return "Warm hit already happened for this prefix fingerprint.";
  }
  if (matchedResult === "cold start") {
    return baselineKind === "session"
      ? "Cold start: only a session-local baseline exists, so this request family has not built a same-target warm reference yet."
      : "Cold start: no prior same-target request exists yet for this prefix fingerprint.";
  }
  if (driftReasons.length > 0 && entropyFindings.length > 0) {
    if (baselineKind === "session") {
      return "Session-local change: both unstable tokens and session-local prompt changes were detected, but not against a same-target warm baseline.";
    }
    return "Cold miss: both prefix drift and unstable tokens were detected.";
  }
  if (driftReasons.length > 0) {
    if (baselineKind === "session") {
      return "Session-local change: stable-prefix text changed versus another request in the same session.";
    }
    return "Cold miss: stable-prefix text drifted across requests.";
  }
  if (entropyKinds.includes("abs_path")) {
    return "Cold miss: absolute filesystem paths are still leaking into the stable prefix.";
  }
  if (
    entropyKinds.includes("uuid")
    || entropyKinds.includes("timestamp")
    || entropyKinds.includes("long_number")
  ) {
    return "Cold miss: runtime identifiers are still leaking into the stable prefix.";
  }
  if (rewriteDetected) {
    return "Request side looked stable, but upstream rewrote the response cache key.";
  }
  if (matchedResult === "cold miss") {
    return "Cold miss: no explicit drift hotspot was recorded, so this is likely structural prompt churn.";
  }
  return "No matched cache-audit request was found for this stability snapshot yet.";
}

function buildActionItems(params: {
  matchedResult: CacheAuditDiagnosis["matchedResult"];
  rewriteDetected: boolean;
  baselineKind: NonNullable<CacheAuditDiagnosisInput["baselineKind"]>;
  entropyFindings: StablePrefixEntropyFinding[];
  driftReasons: StablePrefixDriftReason[];
}): string[] {
  const { matchedResult, rewriteDetected, baselineKind, entropyFindings, driftReasons } = params;
  const entropyKinds = entropyFindings.map((item) => item.kind);
  const items: string[] = [];
  if (matchedResult === "warm hit") {
    items.push("Keep the canonical stable-prefix text byte-stable across adjacent turns.");
    items.push("Only let dynamic context change; avoid expanding new volatile lines back into the stable prefix.");
    return items;
  }
  if (matchedResult === "cold start") {
    items.push("Repeat the same target once more before treating this as a genuine warm-cache miss.");
    if (baselineKind === "session") {
      items.push("Do not compare this against a different prompt family from the same session; wait for a same-target adjacent turn.");
    }
  }
  if (driftReasons.length > 0) {
    items.push("Freeze the canonical stable-prefix text across turns; move changing lines into dynamic context instead of the stable core.");
  }
  if (entropyKinds.includes("abs_path")) {
    items.push("Canonicalize absolute paths before fingerprinting so repeated requests keep the same placeholder-based prefix shape.");
  }
  if (
    entropyKinds.includes("uuid")
    || entropyKinds.includes("timestamp")
    || entropyKinds.includes("long_number")
  ) {
    items.push("Strip timestamps, UUIDs, and long numeric IDs out of the stable prefix and inject them only through dynamic context.");
  }
  if (rewriteDetected) {
    items.push("Treat response-side cache-key rewrites as audit-only; the harness should keep request-side keys and prefix fingerprints stable first.");
  }
  if (items.length === 0 && matchedResult === "cold miss") {
    items.push("Compare this request against the previous fingerprint group and keep tool ordering, prompt scaffolding, and stable-prefix framing identical.");
  }
  if (items.length === 0) {
    items.push("Capture one more adjacent request so the harness can compare fingerprints and learn a stable warm-up target.");
  }
  return items;
}

function buildKillers(params: {
  entropyFindings: StablePrefixEntropyFinding[];
  driftReasons: StablePrefixDriftReason[];
}): CacheAuditKiller[] {
  const entropyFindings = stableUniqueByKey(
    params.entropyFindings,
    (item) => [item.kind, item.segmentKey, item.layer, item.detail].join("::"),
  );
  const driftReasons = stableUniqueByKey(
    params.driftReasons,
    (item) => [item.kind, item.key, item.detail].join("::"),
  );
  const killers: CacheAuditKiller[] = [];
  for (const finding of entropyFindings.slice(0, 3)) {
    killers.push({
      title: `${finding.kind} in ${finding.segmentKey || "unknown segment"}`,
      fix:
        finding.kind === "abs_path"
          ? "Add or strengthen placeholder canonicalization for absolute paths before the stable prefix is fingerprinted."
          : finding.kind === "uuid" || finding.kind === "timestamp" || finding.kind === "long_number"
            ? "Move runtime IDs out of the stable prefix and emit them only through dynamic context."
            : "Normalize this unstable token class before building the stable prefix contract.",
      detail: `${finding.layer || "stable"} · ${finding.detail || "unstable token detected"}`,
    });
  }
  for (const reason of driftReasons.slice(0, 3)) {
    killers.push({
      title: `${reason.kind} on ${reason.key || "unknown segment"}`,
      fix:
        reason.kind === "segment_text_changed"
          ? "Keep this segment byte-stable across adjacent turns, or move the changing portion into dynamic context."
          : reason.kind === "segment_added" || reason.kind === "segment_removed"
            ? "Stop adding/removing this stable-prefix segment between adjacent requests."
            : "Keep the segment role/source stable across adjacent requests.",
      detail: reason.detail || "stable-prefix drift detected",
    });
  }
  return killers.slice(0, 4);
}

function buildHarnessRules(params: {
  entropyFindings: StablePrefixEntropyFinding[];
  driftReasons: StablePrefixDriftReason[];
}): string[] {
  const entropyFindings = stableUniqueByKey(
    params.entropyFindings,
    (item) => [item.kind, item.segmentKey, item.layer].join("::"),
  );
  const driftReasons = stableUniqueByKey(
    params.driftReasons,
    (item) => [item.kind, item.key].join("::"),
  );
  const rules: string[] = [];
  for (const finding of entropyFindings.slice(0, 4)) {
    rules.push(
      `if segment ${finding.segmentKey || "(unknown)"} emits ${finding.kind}, canonicalize it before stable-prefix fingerprinting`,
    );
  }
  for (const reason of driftReasons.slice(0, 4)) {
    rules.push(
      `if segment ${reason.key || "(unknown)"} shows ${reason.kind}, push the changing slice into dynamic context`,
    );
  }
  return rules;
}

export function diagnoseCacheAudit(input?: CacheAuditDiagnosisInput | null): CacheAuditDiagnosis {
  const entropyFindings = Array.isArray(input?.entropyFindings) ? input.entropyFindings : [];
  const driftReasons = Array.isArray(input?.driftReasons) ? input.driftReasons : [];
  const baselineKind = input?.baselineKind ?? "none";
  const rewriteDetected = Boolean(
    input?.requestPromptCacheKey
      && input?.responsePromptCacheKey
      && input.requestPromptCacheKey !== input.responsePromptCacheKey,
  );
  const matchedResult: CacheAuditDiagnosis["matchedResult"] =
    !input
      ? "unmatched"
      : Number(input.cachedInputTokens ?? 0) > 0
        ? "warm hit"
        : baselineKind === "identity" || baselineKind === "request_key"
          ? "cold miss"
          : "cold start";
  return {
    matchedResult,
    rewriteDetected,
    currentState: describeCurrentState({
      matchedResult,
      rewriteDetected,
      baselineKind,
      entropyFindings,
      driftReasons,
    }),
    targetState: matchedResult === "warm hit"
      ? "Target state: keep the same fingerprint and let adjacent turns stay warm."
      : matchedResult === "cold start"
        ? "Target state: repeat the same request family once so the harness can establish a same-target warm baseline."
        : "Target state: same request cache key + same stable-prefix fingerprint + cached input tokens > 0 on the next adjacent turn.",
    optimizationHint: buildOptimizationHint({
      matchedResult,
      rewriteDetected,
      baselineKind,
      entropyFindings,
      driftReasons,
    }),
    killers: buildKillers({ entropyFindings, driftReasons }),
    harnessRules: [
      ...(baselineKind === "session"
        ? ["if drift comes only from a session-local baseline, do not treat it as a same-target cache miss until one more adjacent same-key request confirms it"]
        : []),
      ...buildHarnessRules({ entropyFindings, driftReasons }),
    ],
  };
}
