import { createHash } from "node:crypto";
import {
  extractContentText,
  prependTextToContent,
  replaceContentText,
  rewriteTextForStablePrefix,
  type HostRequestEnvelope,
} from "@tokenpilot/host-adapter";
import type { TokenPilotCodexConfig } from "./config.js";

function computeStablePromptCacheKey(model: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ v: 1, host: "codex", model, stable: true }))
    .digest("hex")
    .slice(0, 24);
  return `lightmem2-codex-${digest}`;
}

function findRootPromptCandidate(messages: HostRequestEnvelope["messages"]): {
  index: number;
  text: string;
} | null {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index] as any;
    if (!message || typeof message !== "object") continue;
    if (message.role !== "system") continue;
    const originalRole = message.metadata?.__codexOriginalRole;
    if (originalRole !== "developer" && originalRole !== "system") continue;
    const text = extractContentText(message.content);
    if (text.trim()) return { index, text };
  }
  return null;
}

function findFirstUserIndex(messages: HostRequestEnvelope["messages"]): number {
  return messages.findIndex((message: any) => message?.role === "user");
}

export function prepareCodexStablePrefix(
  envelope: HostRequestEnvelope,
  config: TokenPilotCodexConfig,
): HostRequestEnvelope {
  if (!config.modules.stabilizer || config.proxyMode.pureForward) return envelope;

  const candidate = findRootPromptCandidate(envelope.messages);
  if (!candidate) return envelope;
  const rewrite = rewriteTextForStablePrefix(candidate.text);

  let nextMessages = envelope.messages;
  let changed = false;

  if (rewrite.changed) {
    nextMessages = envelope.messages.slice();
    const targetMessage = nextMessages[candidate.index] as any;
    const developerForwardedText =
      config.hooks.dynamicContextTarget === "developer" && rewrite.dynamicContextText
        ? `${rewrite.forwardedText}\n\n${rewrite.dynamicContextText}`
        : rewrite.forwardedText;
    nextMessages[candidate.index] = {
      ...targetMessage,
      content: replaceContentText(targetMessage.content, developerForwardedText),
    };
    changed = true;
  }

  if (rewrite.dynamicContextText && config.hooks.dynamicContextTarget === "user") {
    const userIndex = findFirstUserIndex(nextMessages);
    if (userIndex >= 0) {
      const userMessage = nextMessages[userIndex] as any;
      const currentText = extractContentText(userMessage.content);
      if (!currentText.includes(rewrite.dynamicContextText)) {
        if (nextMessages === envelope.messages) nextMessages = envelope.messages.slice();
        nextMessages[userIndex] = {
          ...userMessage,
          content: prependTextToContent(userMessage.content, rewrite.dynamicContextText),
        };
        changed = true;
      }
    }
  }

  const nextMetadata = {
    ...(envelope.metadata ?? {}),
    promptCacheKey: computeStablePromptCacheKey(envelope.model),
    promptCacheRetention: "24h",
  };

  return changed || nextMetadata.promptCacheKey !== envelope.metadata?.promptCacheKey
    ? {
        ...envelope,
        messages: nextMessages,
        metadata: nextMetadata,
      }
    : envelope;
}
