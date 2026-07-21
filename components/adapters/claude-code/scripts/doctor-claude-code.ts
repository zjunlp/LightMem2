import {
  defaultClaudeCodeMcpConfigPath,
  defaultClaudeCodeSettingsPath,
  defaultTokenPilotClaudeCodeConfigPath,
  loadTokenPilotClaudeCodeConfig,
} from "../src/config.js";
import { formatClaudeCodeDoctorReport, inspectClaudeCodeDoctor } from "../src/doctor.js";

async function main() {
  const configPath = process.env.TOKENPILOT_CLAUDE_CODE_CONFIG ?? defaultTokenPilotClaudeCodeConfigPath();
  const config = await loadTokenPilotClaudeCodeConfig(configPath);
  const report = await inspectClaudeCodeDoctor({
    config,
    mcpConfigPath: process.env.CLAUDE_CODE_MCP_CONFIG_PATH ?? defaultClaudeCodeMcpConfigPath(),
    settingsPath: process.env.CLAUDE_CODE_SETTINGS_PATH ?? defaultClaudeCodeSettingsPath(),
    tokenPilotConfigPath: configPath,
  });
  console.log(formatClaudeCodeDoctorReport(report));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
