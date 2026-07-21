import { createProductSurfaceCommandHandler } from "@tokenpilot/product-surface";
import type { CliHostId } from "./registry.js";
import { createClaudeCodeCliBridge } from "./claude-code.js";
import { createCodexCliBridge } from "./codex.js";
import { createOpenClawCliBridge } from "./openclaw.js";

export type CliHostRuntime = {
  handleCommand(ctx: { args: string; sessionId?: string }): Promise<{ text: string }>;
  maybeResolveLatestSessionId(): Promise<string | undefined>;
  resolveSessionId(sessionId?: string): Promise<string | undefined>;
};

export type CliHostPathOverrides = {
  tokenPilotConfigPath?: string;
  hostConfigPath?: string;
  hostAuxConfigPath?: string;
};

type CliHostRuntimeFactory = (target: {
  host: CliHostId;
  sessionId?: string;
  pathOverrides?: CliHostPathOverrides;
}) => CliHostRuntime;

const CLI_HOST_RUNTIME_FACTORIES: Record<CliHostId, CliHostRuntimeFactory> = {
  codex(target) {
    return createCodexCliBridge({
      host: "codex",
      sessionId: target.sessionId,
      pathOverrides: target.pathOverrides,
    });
  },
  "claude-code"(target) {
    const bridge = createClaudeCodeCliBridge({
      host: "claude-code",
      sessionId: target.sessionId,
      pathOverrides: target.pathOverrides,
    });
    return {
      ...bridge,
      async resolveSessionId(sessionId?: string): Promise<string | undefined> {
        return sessionId?.trim() || undefined;
      },
    };
  },
  openclaw(target) {
    const bridge = createOpenClawCliBridge({
      host: "openclaw",
      sessionId: target.sessionId,
    });
    const handler = createProductSurfaceCommandHandler({
      bridge: bridge.bridge,
      configAdapter: bridge.configAdapter,
    });
    return {
      handleCommand(ctx) {
        return handler(ctx);
      },
      maybeResolveLatestSessionId: bridge.maybeResolveLatestSessionId,
      resolveSessionId(sessionId?: string): Promise<string | undefined> {
        return bridge.resolveSessionId(sessionId);
      },
    };
  },
};

export function createCliHostRuntime(target: {
  host: CliHostId;
  sessionId?: string;
  pathOverrides?: CliHostPathOverrides;
}): CliHostRuntime {
  return CLI_HOST_RUNTIME_FACTORIES[target.host](target);
}
