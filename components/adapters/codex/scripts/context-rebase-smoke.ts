import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { runCodexRebaseProviderSmoke } from "../src/context-rebase-provider-smoke.js";
import { runCodexRebaseMockSmoke } from "../src/context-rebase-smoke.js";

function optionValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return argument?.slice(prefix.length);
}

function printHelp(): void {
  console.log([
    "Usage: npm run smoke:context-rebase:codex -- [options]",
    "",
    "Options:",
    "  --mode=mock|provider       Run offline mock (default) or explicit provider smoke.",
    "  --model=<name>             Provider model; default is gpt-5.4-mini.",
    "  --base-url=<url>           Provider base URL; defaults to OPENAI_BASE_URL.",
    "  --credentials-file=<path> Provider env file; defaults to <initial cwd>/.env.",
    "  --continuation-turns=<n>  Provider continuation turns, from 5 to 20.",
    "  --output-dir=<path>        Directory for sanitized evidence JSON.",
    "  --help                     Show this help.",
    "",
    "Mock mode never reads an API key. Provider mode reads OPENAI_API_KEY only",
    "from the process environment or the selected local env file. Neither mode",
    "persists raw prompts, headers, response ids, provider error bodies, or",
    "encrypted reasoning payloads in its evidence file.",
  ].join("\n"));
}

function envValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  )) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function loadProviderEnvFile(path: string): Promise<void> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const rawLine of text.replace(/^\uFEFF/u, "").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim();
    if (name !== "OPENAI_API_KEY" && name !== "OPENAI_BASE_URL") continue;
    if (process.env[name]?.trim()) continue;
    process.env[name] = envValue(line.slice(separator + 1));
  }
}

function integerOption(name: string): number | undefined {
  const value = optionValue(name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`--${name} must be an integer`);
  return parsed;
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    printHelp();
    return;
  }
  const mode = optionValue("mode") ?? "mock";
  if (mode === "provider") {
    const initialCwd = process.env.INIT_CWD?.trim() || process.cwd();
    const envFile = resolve(optionValue("credentials-file") ?? resolve(initialCwd, ".env"));
    await loadProviderEnvFile(envFile);
    const baseUrl = optionValue("base-url")?.trim() || process.env.OPENAI_BASE_URL?.trim();
    if (!baseUrl) throw new Error("Provider smoke requires OPENAI_BASE_URL or --base-url");
    const result = await runCodexRebaseProviderSmoke({
      baseUrl,
      model: optionValue("model"),
      outputDir: optionValue("output-dir"),
      continuationTurns: integerOption("continuation-turns"),
    });
    console.log(JSON.stringify({
      ok: true,
      mode: result.evidence.mode,
      provider: result.evidence.provider,
      endpointHost: result.evidence.endpoint.host,
      model: result.evidence.model,
      artifactPath: result.artifactPath,
      artifactSha256: result.artifactSha256,
      encryptedReasoningPresent: result.evidence.capability.encryptedReasoningPresent,
      verifiedItemTypes: result.evidence.capability.realProviderVerifiedItemTypes,
      rejectedItemTypes: result.evidence.capability.realProviderRejectedItemTypes,
      rebaseCommitted: result.evidence.rebase.committed,
      sentinel: result.evidence.rebase.sentinel,
      continuationTurns: result.evidence.rebase.responseChain.continuationTurns,
      restartPreserved: result.evidence.rebase.responseChain.restartPreserved,
      observedBreakEvenTurn: result.evidence.usage.observedBreakEvenTurn ?? null,
      projectedBreakEvenTurn: result.evidence.usage.projectedBreakEvenTurn ?? null,
      observedSavedInputTokens: result.evidence.usage.observedSavedInputTokens,
    }, null, 2));
    return;
  }
  if (mode !== "mock") {
    throw new Error("Smoke mode must be --mode=mock or --mode=provider");
  }
  const result = await runCodexRebaseMockSmoke({
    model: optionValue("model"),
    outputDir: optionValue("output-dir"),
  });
  console.log(JSON.stringify({
    ok: true,
    mode: result.evidence.mode,
    artifactPath: result.artifactPath,
    artifactSha256: result.artifactSha256,
    sentinel: result.evidence.happyPath.sentinel,
    continuationTurns: result.evidence.happyPath.responseChain.continuationTurns,
    fallbackSucceeded: result.evidence.fallback.fallbackSucceeded,
    moduleMatrixPassed: result.evidence.moduleMatrix.every((entry) => entry.isolationPassed),
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
