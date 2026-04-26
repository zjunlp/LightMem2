/* eslint-disable @typescript-eslint/no-explicit-any */
import { appendJsonl } from "./io.js";

export function resolveLlmHookTapPath(debugTapPath: string): string {
  if (debugTapPath.endsWith(".jsonl")) {
    return debugTapPath.slice(0, -".jsonl".length) + ".llm-hooks.jsonl";
  }
  return `${debugTapPath}.llm-hooks.jsonl`;
}

export function installLlmHookTap(
  api: any,
  cfg: { debugTapProviderTraffic: boolean; debugTapPath: string },
  logger: { info: (message: string) => void; warn: (message: string) => void },
  helpers: {
    hookOn: (api: any, event: string, handler: (...args: any[]) => any) => void;
    extractTurnObservations: (event: any, helpers: any) => any[];
    contentToText: (value: unknown) => string;
    contextSafeRecovery: (details: unknown) => Record<string, unknown> | undefined;
    memoryFaultRecoverToolName: string;
    extractSessionKey: (event: any) => string;
    extractLastUserMessage: (event: any) => string;
  },
): void {
  if (!cfg.debugTapProviderTraffic) return;
  const llmHookTapPath = resolveLlmHookTapPath(cfg.debugTapPath);
  const hookNames = [
    "before_prompt_build",
    "before_agent_start",
    "llm_input",
    "llm_output",
    "session_start",
    "session_end",
    "before_reset",
    "agent_end",
  ];
  for (const hookName of hookNames) {
    helpers.hookOn(api, hookName, async (event: any) => {
      try {
        const turnObservations = helpers.extractTurnObservations(event, {
          contentToText: helpers.contentToText,
          contextSafeRecovery: helpers.contextSafeRecovery,
          memoryFaultRecoverToolName: helpers.memoryFaultRecoverToolName,
        });
        const rec = {
          at: new Date().toISOString(),
          hook: hookName,
          sessionKey: helpers.extractSessionKey(event),
          derived: {
            lastUserMessage: helpers.extractLastUserMessage(event),
            turnObservationCount: turnObservations.length,
            turnObservations,
          },
          event,
        };
        await appendJsonl(llmHookTapPath, rec);
      } catch (err) {
        logger.warn(`[plugin-runtime] llm-hook tap write failed(${hookName}): ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }
  logger.info(`[plugin-runtime] LLM hook tap enabled. path=${llmHookTapPath}`);
}
