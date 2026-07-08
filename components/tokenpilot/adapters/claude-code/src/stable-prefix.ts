import { createHash } from "node:crypto";
import {
  applyStablePrefixToInstructions,
  extractContentText,
  replaceContentText,
  type HostRequestEnvelope,
} from "@tokenpilot/host-adapter";
import type { TokenPilotClaudeCodeConfig } from "./config.js";

function computeStablePromptCacheKey(model: string, stableTexts: string[]): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({
      v: 1,
      host: "claude-code",
      model,
      stableTexts: stableTexts.filter((text) => text.trim().length > 0),
    }))
    .digest("hex")
    .slice(0, 24);
  return `lightmem2-claude-${digest}`;
}

function findClaudeRootPromptCandidate(messages: HostRequestEnvelope["messages"]): {
  index: number;
  text: string;
} | null {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || message.role !== "system") continue;
    const text = extractContentText(message.content);
    if (text.trim()) return { index, text };
  }
  return null;
}

export function prepareClaudeStablePrefix(
  envelope: HostRequestEnvelope,
  config: TokenPilotClaudeCodeConfig,
): HostRequestEnvelope {
  if (!config.modules.stabilizer) return envelope;
  const originalPromptCacheKey =
    typeof (envelope.rawPayload as Record<string, unknown> | undefined)?.prompt_cache_key === "string"
      && String((envelope.rawPayload as Record<string, unknown>).prompt_cache_key).trim().length > 0
      ? String((envelope.rawPayload as Record<string, unknown>).prompt_cache_key)
      : typeof envelope.metadata?.promptCacheKey === "string" && envelope.metadata.promptCacheKey.trim().length > 0
        ? envelope.metadata.promptCacheKey
        : undefined;

  const prepared = applyStablePrefixToInstructions({
    envelope,
    dynamicContextTarget: config.hooks.dynamicContextTarget,
    mergeDynamicContextIntoInstructions: config.hooks.dynamicContextTarget === "developer",
  });
  const stableInstructionText = typeof prepared.instructions === "string" ? prepared.instructions : "";
  const rootCandidate = findClaudeRootPromptCandidate(prepared.messages);
  const stablePromptParts = [
    stableInstructionText,
    rootCandidate?.text ?? "",
  ];
  const nextPromptCacheKey = computeStablePromptCacheKey(prepared.model, stablePromptParts);
  if (nextPromptCacheKey === prepared.metadata?.promptCacheKey) {
    return prepared;
  }
  return {
    ...prepared,
    metadata: {
      ...(prepared.metadata ?? {}),
      originalPromptCacheKey,
      promptCacheKey: nextPromptCacheKey,
    },
  };
}

export function replaceClaudeMessageText(
  envelope: HostRequestEnvelope,
  messageIndex: number,
  nextText: string,
): HostRequestEnvelope {
  const message = envelope.messages[messageIndex];
  if (!message) return envelope;
  const updated = envelope.messages.slice();
  updated[messageIndex] = {
    ...message,
    content: replaceContentText(message.content, nextText),
  };
  return {
    ...envelope,
    messages: updated,
  };
}
