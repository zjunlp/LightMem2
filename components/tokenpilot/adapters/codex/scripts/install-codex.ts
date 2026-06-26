import { installCodexTokenPilot } from "../src/install.js";

installCodexTokenPilot({
  codexConfigPath: process.env.CODEX_CONFIG_PATH,
  tokenPilotConfigPath: process.env.TOKENPILOT_CODEX_CONFIG,
  hooksConfigPath: process.env.CODEX_HOOKS_CONFIG_PATH,
}).then((result) => {
  console.log(`Installed TokenPilot Codex provider '${result.providerName}'`);
  console.log(`Codex config: ${result.codexConfigPath}`);
  console.log(`TokenPilot config: ${result.tokenPilotConfigPath}`);
  console.log(`Codex hooks config: ${result.hooksConfigPath} (${result.hooksInstalled ? "installed" : "skipped"})`);
  console.log(`Recovery MCP server: ${result.mcpServerName}`);
  console.log(`Proxy base URL: ${result.baseUrl}`);
  console.log("TokenPilot will auto-start from Codex SessionStart hooks after hooks are trusted.");
  console.log("Default Codex model_provider has been switched to tokenpilot.");
  console.log("For manual troubleshooting, run: tokenpilot-codex start");
  console.log("If Codex reports hooks need review, run /hooks and trust the TokenPilot hooks.");
}).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
