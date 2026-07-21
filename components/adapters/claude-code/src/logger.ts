export type TokenPilotClaudeCodeLogger = {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
};

export function createConsoleLogger(debugEnabled = false): TokenPilotClaudeCodeLogger {
  return {
    debug(message) {
      if (debugEnabled) console.error(`[tokenpilot-claude-code] ${message}`);
    },
    info(message) {
      console.error(`[tokenpilot-claude-code] ${message}`);
    },
    warn(message) {
      console.error(`[tokenpilot-claude-code] warn: ${message}`);
    },
    error(message) {
      console.error(`[tokenpilot-claude-code] error: ${message}`);
    },
  };
}
