import {
  defaultTokenPilotConfigPath,
  loadTokenPilotCodexConfig,
} from "../src/config.js";
import {
  readRecentCodexCacheAuditRecords,
  summarizeCodexCacheAudit,
} from "../src/cache-audit.js";

async function main() {
  const tokenPilotConfigPath = process.env.TOKENPILOT_CODEX_CONFIG ?? defaultTokenPilotConfigPath();
  const config = await loadTokenPilotCodexConfig(tokenPilotConfigPath);
  const records = await readRecentCodexCacheAuditRecords(config.stateDir, 64);
  if (records.length === 0) {
    console.log("TokenPilot Codex cache audit: no records yet.");
    return;
  }
  const summary = summarizeCodexCacheAudit(records);
  console.log("TokenPilot Codex cache audit report:");
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
