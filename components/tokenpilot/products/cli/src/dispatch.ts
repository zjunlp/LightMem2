import type { TokenPilotProductCommandResult } from "@tokenpilot/host-adapter";
import { createProductSurfaceCommandHandler } from "@tokenpilot/product-surface";
import {
  type CliHostId,
  readCliContextState,
  updateCliContextState,
} from "./context-store.js";
import { createClaudeCodeCliBridge } from "./hosts/claude-code.js";
import { createCodexCliBridge } from "./hosts/codex.js";
import { createOpenClawCliBridge } from "./hosts/openclaw.js";
import { formatCliUsage } from "./usage.js";

type HostTarget = {
  host: CliHostId;
  sessionId?: string;
};

function parseHost(value: string | undefined): CliHostId | undefined {
  if (value === "openclaw" || value === "codex" || value === "claude-code") return value;
  return undefined;
}

function parseBooleanContextCommand(args: string[]): boolean {
  return args.length === 1 && args[0] === "context";
}

async function resolveDefaultTarget(): Promise<HostTarget | undefined> {
  const state = await readCliContextState();
  const host = state.lastActiveHost;
  if (!host) return undefined;
  const sessionId = state.lastSessionByHost?.[host];
  return { host, sessionId };
}

async function resolveTarget(argv: string[]): Promise<{
  target?: HostTarget;
  commandArgs: string[];
  handledText?: string;
}> {
  if (parseBooleanContextCommand(argv)) {
    const state = await readCliContextState();
    const lines = [
      "LightMem2 CLI context:",
      `- lastActiveHost: ${state.lastActiveHost ?? "(unset)"}`,
      `- openclaw session: ${state.lastSessionByHost?.openclaw ?? "(unset)"}`,
      `- codex session: ${state.lastSessionByHost?.codex ?? "(unset)"}`,
      `- claude-code session: ${state.lastSessionByHost?.["claude-code"] ?? "(unset)"}`,
      `- lastUpdatedAt: ${state.lastUpdatedAt ?? "(unset)"}`,
    ];
    return { commandArgs: [], handledText: lines.join("\n") };
  }

  if (argv[0] === "use") {
    const host = parseHost(argv[1]);
    if (!host) {
      return { commandArgs: [], handledText: `Unknown host.\n\n${formatCliUsage()}` };
    }
    if (argv[2] === "session") {
      let sessionId = String(argv[3] ?? "").trim();
      if (!sessionId) {
        return { commandArgs: [], handledText: "Missing session id." };
      }
      if (host === "codex") {
        const codex = createCodexCliBridge({ host: "codex", sessionId });
        sessionId = (await codex.resolveSessionId(sessionId)) ?? sessionId;
      }
      await updateCliContextState({ host, sessionId });
      return { commandArgs: [], handledText: `Default context = ${host} / ${sessionId}` };
    }
    await updateCliContextState({ host });
    return { commandArgs: [], handledText: `Default host = ${host}` };
  }

  const explicitHost = parseHost(argv[0]);
  if (explicitHost) {
    if (argv[1] === "session") {
      const sessionId = String(argv[2] ?? "").trim();
      const commandArgs = argv.slice(3);
      return {
        target: { host: explicitHost, sessionId: sessionId || undefined },
        commandArgs,
      };
    }
    return {
      target: { host: explicitHost },
      commandArgs: argv.slice(1),
    };
  }

  const defaultTarget = await resolveDefaultTarget();
  return {
    target: defaultTarget,
    commandArgs: argv,
  };
}

export async function dispatchCli(argv: string[]): Promise<TokenPilotProductCommandResult> {
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    return { text: formatCliUsage() };
  }

  const resolved = await resolveTarget(argv);
  if (resolved.handledText) {
    return { text: resolved.handledText };
  }

  const { target, commandArgs } = resolved;
  if (!target) {
    return {
      text: `No default host is selected.\n\n${formatCliUsage()}`,
    };
  }
  if (commandArgs.length === 0) {
    return {
      text: formatCliUsage(),
    };
  }

  if (target.host === "codex") {
    const { handleCommand, maybeResolveLatestSessionId, resolveSessionId } = createCodexCliBridge({
      host: "codex",
      sessionId: target.sessionId,
    });
    const result = await handleCommand({
      args: commandArgs.join(" "),
      sessionId: target.sessionId,
    });

    const resolvedSessionId = target.sessionId
      ? await resolveSessionId(target.sessionId)
      : await maybeResolveLatestSessionId();
    await updateCliContextState({
      host: target.host,
      sessionId: resolvedSessionId,
    });
    return result;
  }

  if (target.host === "claude-code") {
    const { handleCommand, maybeResolveLatestSessionId } = createClaudeCodeCliBridge({
      host: "claude-code",
      sessionId: target.sessionId,
    });
    const result = await handleCommand({
      args: commandArgs.join(" "),
      sessionId: target.sessionId,
    });

    const resolvedSessionId = target.sessionId ?? await maybeResolveLatestSessionId();
    await updateCliContextState({
      host: target.host,
      sessionId: resolvedSessionId,
    });
    return result;
  }

  const { bridge, configAdapter, maybeResolveLatestSessionId } = createOpenClawCliBridge({
    host: "openclaw",
    sessionId: target.sessionId,
  });
  const handler = createProductSurfaceCommandHandler({
    bridge,
    configAdapter,
  });
  const result = await handler({
    args: commandArgs.join(" "),
    sessionId: target.sessionId,
  });

  const resolvedSessionId = target.sessionId ?? await maybeResolveLatestSessionId();
  await updateCliContextState({
    host: target.host,
    sessionId: resolvedSessionId,
  });
  return result;
}
