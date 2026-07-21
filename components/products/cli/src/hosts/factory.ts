import { createProductSurfaceCommandHandler } from "@tokenpilot/product-surface";
import type { CliHostPathOverrides } from "../context-store.js";
import { createClaudeCodeCliBridge } from "./claude-code.js";
import { createCodexCliBridge } from "./codex.js";
import { createOpenClawCliBridge } from "./openclaw.js";
import {
  CLI_HOSTS,
  getCliHostRegistration,
  registerCliHostProducts,
  type CliHostId,
  type CliHostRegistration,
  type CliHostRuntime,
} from "./registry.js";

export type { CliHostPathOverrides } from "../context-store.js";
export type { CliHostRuntime } from "./registry.js";

const CLI_HOST_REGISTRATIONS: CliHostRegistration[] = CLI_HOSTS.map((host) => ({
  ...host,
  createRuntime(target) {
    if (host.hostId === "codex") {
      return createCodexCliBridge({
        host: "codex",
        sessionId: target.sessionId,
        pathOverrides: target.pathOverrides,
      });
    }
    if (host.hostId === "claude-code") {
      return createClaudeCodeCliBridge({
        host: "claude-code",
        sessionId: target.sessionId,
        pathOverrides: target.pathOverrides,
      });
    }
    const bridge = createOpenClawCliBridge({ host: "openclaw", sessionId: target.sessionId });
    const handler = createProductSurfaceCommandHandler({
      bridge: bridge.bridge,
      configAdapter: bridge.configAdapter,
    });
    return {
      handleCommand(ctx) {
        return handler(ctx);
      },
      maybeResolveLatestSessionId: bridge.maybeResolveLatestSessionId,
      resolveSessionId(sessionId?: string) {
        return bridge.resolveSessionId(sessionId);
      },
    };
  },
}));

export function registerBuiltInCliHostProducts(): void {
  registerCliHostProducts(CLI_HOST_REGISTRATIONS);
}

export function createCliHostRuntime(target: {
  host: CliHostId;
  sessionId?: string;
  pathOverrides?: CliHostPathOverrides;
}): CliHostRuntime {
  return getCliHostRegistration(target.host).createRuntime(target);
}
