import { readFile } from "node:fs/promises";
import { resolveOpenClawConfigPath } from "../src/context-stack/integration/openclaw-paths.js";
import { pluginConfigRecord, resolveStateDir } from "../src/commands/tokenpilot/host-config-adapter.js";
import {
  readRecentOpenClawCacheAuditRecords,
  summarizeOpenClawCacheAudit,
} from "../src/cache-audit.js";

async function main() {
  const configPath = process.env.OPENCLAW_CONFIG_PATH ?? resolveOpenClawConfigPath();
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  const pluginCfg = pluginConfigRecord(config) ?? {};
  const stateDir = resolveStateDir(config) ?? (typeof pluginCfg.stateDir === "string" ? pluginCfg.stateDir : "");
  if (!stateDir) {
    console.log("TokenPilot OpenClaw cache audit: stateDir is not configured.");
    return;
  }
  const records = await readRecentOpenClawCacheAuditRecords(stateDir, 64);
  if (records.length === 0) {
    console.log("TokenPilot OpenClaw cache audit: no records yet.");
    return;
  }
  const summary = summarizeOpenClawCacheAudit(records);
  console.log("TokenPilot OpenClaw cache audit report:");
  console.log(`- records: ${summary.totalRecords}`);
  console.log(`- latest session: ${summary.latestSessionId ?? "(unknown)"}`);
  console.log(`- latest fingerprint: ${summary.latestFingerprint ?? "(unknown)"}`);
  console.log(`- warm candidates: ${summary.warmCandidates}`);
  console.log(`- warm cache hits: ${summary.warmHits}`);
  console.log(`- warm cache misses: ${summary.warmMisses}`);
  console.log(`- warm hit rate: ${summary.hitRatePercent}%`);
  console.log(`- response cache key rewrites: ${summary.responsePromptCacheKeyRewriteCount}`);
  console.log(
    `- top entropy kinds: ${summary.topEntropyKinds.length > 0
      ? summary.topEntropyKinds.map((item) => `${item.key}=${item.count}`).join(", ")
      : "(none)"}`,
  );
  console.log(
    `- top drift keys: ${summary.topDriftKeys.length > 0
      ? summary.topDriftKeys.map((item) => `${item.key}=${item.count}`).join(", ")
      : "(none)"}`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
