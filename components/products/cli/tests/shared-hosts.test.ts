import assert from "node:assert/strict";
import test from "node:test";
import type { ProductSurfaceConfigAdapter } from "@lightmem2/host-adapter";
import type { CacheAuditRecord } from "@lightmem2/stabilizer";
import {
  buildSessionReportResult,
  resolvePreferredSessionId,
  selectLatestNonWarmCacheDiagnosisFromCacheAudit,
} from "../src/hosts/shared.js";

const passthroughConfigAdapter: ProductSurfaceConfigAdapter = {
  pluginConfigRecord(config) {
    return (config.plugin as Record<string, unknown>) ?? {};
  },
  pluginEntryRecord(config) {
    return config;
  },
  ensurePluginConfig(config) {
    const plugin = (config.plugin as Record<string, unknown> | undefined) ?? {};
    config.plugin = plugin;
    return plugin;
  },
  ensurePluginEntry(config) {
    return config;
  },
  resolveStateDir(config) {
    return typeof config.stateDir === "string" ? config.stateDir : undefined;
  },
};

function makeCacheAuditRecord(overrides: Partial<CacheAuditRecord> = {}): CacheAuditRecord {
  return {
    at: "2026-07-08T10:00:00.000Z",
    sessionId: "session-a",
    model: "test-model",
    stream: true,
    stablePrefixFingerprint: "fp-a",
    stablePrefix: {
      schemaVersion: 1,
      stableCore: [],
      semiStableContext: [],
    },
    entropyFindings: [],
    driftReasons: [],
    originalRequestPromptCacheKey: "host-cache-a",
    requestPromptCacheKey: "cache-a",
    responsePromptCacheKey: "cache-a",
    cachedInputTokens: 0,
    usage: null,
    status: 200,
    ...overrides,
  };
}

test("shared host helpers prefer explicit session then latest session then latest ux session", async () => {
  const explicit = await resolvePreferredSessionId({
    explicitSessionId: " session-explicit ",
    stateDir: "/tmp/state",
    async resolveLatestSessionId() {
      return "session-latest";
    },
    async readLatestUxEffect() {
      return { sessionId: "session-ux" };
    },
  });
  const latestSession = await resolvePreferredSessionId({
    stateDir: "/tmp/state",
    async resolveLatestSessionId() {
      return "session-latest";
    },
    async readLatestUxEffect() {
      return { sessionId: "session-ux" };
    },
  });
  const latestUx = await resolvePreferredSessionId({
    stateDir: "/tmp/state",
    async resolveLatestSessionId() {
      return undefined;
    },
    async readLatestUxEffect() {
      return { sessionId: "session-ux" };
    },
  });

  assert.equal(explicit, "session-explicit");
  assert.equal(latestSession, "session-latest");
  assert.equal(latestUx, "session-ux");
});

test("shared host helpers return shared report fallback messages and report text", async () => {
  const noStateDir = await buildSessionReportResult({
    currentConfig: {},
    configAdapter: passthroughConfigAdapter,
    async resolveLatestSessionId() {
      return undefined;
    },
    async readLatestUxEffect() {
      return null;
    },
    async readSessionAggregate() {
      return null;
    },
  });

  const noStats = await buildSessionReportResult({
    currentConfig: { stateDir: "/tmp/state" },
    configAdapter: passthroughConfigAdapter,
    async resolveLatestSessionId() {
      return undefined;
    },
    async readLatestUxEffect() {
      return null;
    },
    async readSessionAggregate() {
      return null;
    },
  });

  const noAggregate = await buildSessionReportResult({
    currentConfig: { stateDir: "/tmp/state" },
    configAdapter: passthroughConfigAdapter,
    async resolveLatestSessionId() {
      return "session-latest";
    },
    async readLatestUxEffect() {
      return {
        at: "2026-06-28T12:20:00.000Z",
        sessionId: "session-ux",
        model: "test-model",
        countMode: "chars",
        beforeCount: 1000,
        afterCount: 900,
        savedCount: 100,
      };
    },
    async readSessionAggregate(_stateDir, sessionId) {
      assert.equal(sessionId, "session-latest");
      return null;
    },
  });

  const report = await buildSessionReportResult({
    currentConfig: {
      stateDir: "/tmp/state",
      plugin: {
        ux: {
          details: true,
        },
      },
    },
    configAdapter: passthroughConfigAdapter,
    async resolveLatestSessionId() {
      return "session-a";
    },
    async readLatestUxEffect() {
      return {
        at: "2026-06-28T12:20:00.000Z",
        sessionId: "session-a",
        model: "test-model",
        countMode: "chars",
        beforeCount: 1000,
        afterCount: 600,
        savedCount: 400,
      };
    },
    async readSessionAggregate() {
      return {
        turns: 2,
        latestCountMode: "chars",
        tokenOptimizedTurns: 0,
        tokenSavedCount: 0,
        avgSavedTokensPerOptimizedTurn: 0,
        charOptimizedTurns: 2,
        charSavedCount: 800,
        avgSavedCharsPerOptimizedTurn: 400,
      };
    },
    async readRecentCacheAuditRecords(_stateDir, sessionId) {
      assert.equal(sessionId, "session-a");
      return [
        makeCacheAuditRecord({
          cachedInputTokens: 1024,
          baselineKind: "request_key",
        }),
        makeCacheAuditRecord({
          at: "2026-07-08T10:01:00.000Z",
          driftReasons: [{ kind: "segment_text_changed", key: "instructions", detail: "changed" }],
          responsePromptCacheKey: "cache-b",
          cachedInputTokens: 0,
          baselineKind: "request_key",
        }),
      ];
    },
  });

  assert.equal(noStateDir.text, "TokenPilot stateDir is not configured.");
  assert.equal(noStats.text, "No TokenPilot session stats yet.");
  assert.equal(noAggregate.text, "No TokenPilot savings recorded yet for session session-latest.");
  assert.match(report.text, /session: session-a/);
  assert.match(report.text, /saved chars: 800/);
  assert.match(report.text, /cache warm hits: 1\/1 \(100%\)/i);
  assert.match(report.text, /response cache key rewrites: 1/i);
  assert.match(report.text, /latest cold miss drift: instructions/i);
  assert.match(report.text, /latest cold miss hint: (Session-local change|Fingerprint drift|Cold miss)/i);
});

test("buildSessionReportResult surfaces cache audit summary even when savings aggregate is absent", async () => {
  const report = await buildSessionReportResult({
    currentConfig: {
      stateDir: "/tmp/tokenpilot-state",
      ux: { details: true },
    },
    explicitSessionId: "session-cache-only",
    configAdapter: {
      resolveStateDir(config) {
        return String((config as Record<string, unknown>).stateDir ?? "");
      },
      pluginConfigRecord(config) {
        return config as Record<string, unknown>;
      },
      pluginEntryRecord() {
        return {};
      },
      ensurePluginConfig(config) {
        return config as Record<string, unknown>;
      },
      ensurePluginEntry(config) {
        return config as Record<string, unknown>;
      },
    },
    async resolveLatestSessionId() {
      return "session-cache-only";
    },
    async readLatestUxEffect() {
      return {
        sessionId: "session-cache-only",
        countMode: "chars",
      };
    },
    async readSessionAggregate() {
      return null;
    },
    async readRecentCacheAuditRecords() {
      return [
        makeCacheAuditRecord({
          sessionId: "session-cache-only",
          stablePrefixFingerprint: "fp-cache",
          requestPromptCacheKey: "cache-z",
          responsePromptCacheKey: "cache-z",
          entropyFindings: [{ kind: "abs_path", segmentKey: "developer", layer: "stable_core", detail: "path leaked" }],
          cachedInputTokens: 1024,
        }),
        makeCacheAuditRecord({
          at: "2026-07-08T10:01:00.000Z",
          sessionId: "session-cache-only",
          stablePrefixFingerprint: "fp-cache",
          requestPromptCacheKey: "cache-z",
          responsePromptCacheKey: "cache-z",
          entropyFindings: [{ kind: "abs_path", segmentKey: "developer", layer: "stable_core", detail: "path leaked" }],
          cachedInputTokens: 512,
        }),
      ];
    },
  });

  assert.match(report.text, /^TokenPilot report:/);
  assert.match(report.text, /session: session-cache-only/);
  assert.match(report.text, /no savings recorded yet/i);
  assert.match(report.text, /cache warm hits: 1\/1 \(100%\)/i);
});

test("selectLatestNonWarmCacheDiagnosisFromCacheAudit returns newest non-warm diagnosis details", () => {
  const result = selectLatestNonWarmCacheDiagnosisFromCacheAudit([
    makeCacheAuditRecord({
      cachedInputTokens: 1024,
      baselineKind: "request_key",
    }),
    makeCacheAuditRecord({
      at: "2026-07-08T10:02:00.000Z",
      stablePrefixFingerprint: "fp-a",
      driftReasons: [{ kind: "segment_text_changed", key: "instructions", detail: "changed" }],
      requestPromptCacheKey: "cache-a",
      responsePromptCacheKey: "cache-a",
      cachedInputTokens: 0,
      baselineKind: "request_key",
    }),
  ]);

  assert.equal(result?.matchedResult, "cold miss");
  assert.equal(result?.driftKeys[0], "instructions");
  assert.match(result?.optimizationHint ?? "", /(Session-local|Fingerprint drift|Cold start)/i);
});
