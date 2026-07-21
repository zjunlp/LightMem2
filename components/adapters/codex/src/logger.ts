export type TokenPilotCodexLogger = {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
};

export function createConsoleLogger(debugEnabled = false): TokenPilotCodexLogger {
  return {
    debug(message) {
      if (debugEnabled) console.error(`[tokenpilot-codex] ${message}`);
    },
    info(message) {
      console.error(`[tokenpilot-codex] ${message}`);
    },
    warn(message) {
      console.error(`[tokenpilot-codex] warn: ${message}`);
    },
    error(message) {
      console.error(`[tokenpilot-codex] error: ${message}`);
    },
  };
}
