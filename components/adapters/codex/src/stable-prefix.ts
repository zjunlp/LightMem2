import { createHash } from "node:crypto";
import {
  applyStablePrefixToInstructions,
  applyStablePrefixToMessage,
  extractContentText,
  findFirstUserMessageIndex,
  rewriteTextForStablePrefix,
} from "@lightmem2/stabilizer";
import type { HostRequestEnvelope } from "@lightmem2/host-adapter";
import type { TokenPilotCodexConfig } from "./config.js";

function computeStablePromptCacheKey(model: string, stableTexts: string[]): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({
      v: 2,
      host: "codex",
      model,
      stableTexts: stableTexts.filter((text) => text.trim().length > 0),
    }))
    .digest("hex")
    .slice(0, 24);
  return `lightmem2-codex-${digest}`;
}

type CodexPromptRewrite = ReturnType<typeof rewriteTextForStablePrefix>;

function normalizeCodexAgentSeparator(text: string): string {
  return String(text ?? "").replace(/agent=<AGENT_ID>\s+\|/g, "agent=<AGENT_ID>|");
}

function rewriteCodexPromptForStablePrefix(promptText: string): CodexPromptRewrite {
  const rewrite = rewriteTextForStablePrefix(promptText);
  return {
    ...rewrite,
    canonicalText: normalizeCodexAgentSeparator(rewrite.canonicalText),
    forwardedText: normalizeCodexAgentSeparator(rewrite.forwardedText),
  };
}

function scoreRootPromptCandidate(message: HostRequestEnvelope["messages"][number]): number {
  const originalRole = (message as any)?.metadata?.__codexOriginalRole;
  const text = extractContentText((message as any)?.content);
  let score = 0;
  if (originalRole === "developer") score += 4;
  else if (originalRole === "system") score += 2;
  if (/Your working directory is:/i.test(text)) score += 2;
  if (/Runtime:\s*agent=/i.test(text)) score += 2;
  return score;
}

function findRootPromptCandidate(messages: HostRequestEnvelope["messages"]): {
  index: number;
  text: string;
} | null {
  let best: { index: number; text: string; score: number } | null = null;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index] as any;
    if (!message || typeof message !== "object") continue;
    if (message.role !== "system") continue;
    const originalRole = message.metadata?.__codexOriginalRole;
    if (originalRole !== "developer" && originalRole !== "system") continue;
    const text = extractContentText(message.content);
    if (!text.trim()) continue;
    const score = scoreRootPromptCandidate(message);
    if (!best || score > best.score) {
      best = { index, text, score };
    }
  }
  return best ? { index: best.index, text: best.text } : null;
}

function mergeDynamicContextTexts(...texts: Array<string | undefined>): string {
  const merged: string[] = [];
  for (const text of texts) {
    for (const line of String(text ?? "").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || merged.includes(trimmed)) continue;
      merged.push(trimmed);
    }
  }
  return merged.join("\n");
}

function uniqueStablePromptParts(stableTexts: string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const text of stableTexts) {
    const normalized = text.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(text);
  }
  return unique;
}

function hasDeveloperDynamicContextMessage(
  messages: HostRequestEnvelope["messages"],
  dynamicContextText: string,
): boolean {
  const target = dynamicContextText.trim();
  if (!target) return true;
  return messages.some((message: any) => {
    if (!message || typeof message !== "object") return false;
    if (message.role !== "system") return false;
    const originalRole = message.metadata?.__codexOriginalRole;
    if (originalRole !== "developer" && originalRole !== "system") return false;
    return extractContentText(message.content).trim() === target;
  });
}

function insertDeveloperDynamicContextMessage(params: {
  envelope: HostRequestEnvelope;
  dynamicContextText: string;
  afterMessageIndex?: number;
}): HostRequestEnvelope {
  const dynamicContextText = params.dynamicContextText.trim();
  if (!dynamicContextText) return params.envelope;
  if (hasDeveloperDynamicContextMessage(params.envelope.messages, dynamicContextText)) {
    return params.envelope;
  }

  const insertAt =
    typeof params.afterMessageIndex === "number"
      ? Math.max(0, Math.min(params.envelope.messages.length, params.afterMessageIndex + 1))
      : (() => {
          const userIndex = findFirstUserMessageIndex(params.envelope.messages);
          return userIndex >= 0 ? userIndex : params.envelope.messages.length;
        })();
  const nextMessages = params.envelope.messages.slice();
  nextMessages.splice(insertAt, 0, {
    role: "system",
    content: dynamicContextText,
    metadata: {
      __codexOriginalRole: "developer",
    },
  } as HostRequestEnvelope["messages"][number]);
  return {
    ...params.envelope,
    messages: nextMessages,
  };
}

export function prepareCodexStablePrefix(
  envelope: HostRequestEnvelope,
  config: TokenPilotCodexConfig,
): HostRequestEnvelope {
  if (!config.modules.stabilizer || config.proxyMode.pureForward) return envelope;
  const originalPromptCacheKey =
    typeof envelope.metadata?.promptCacheKey === "string" && envelope.metadata.promptCacheKey.trim().length > 0
      ? envelope.metadata.promptCacheKey
      : undefined;

  const candidate = findRootPromptCandidate(envelope.messages);
  const instructionText = typeof envelope.instructions === "string" ? envelope.instructions : "";
  const instructionRewrite = instructionText.trim()
    ? rewriteCodexPromptForStablePrefix(instructionText)
    : null;
  const rootRewrite = candidate ? rewriteCodexPromptForStablePrefix(candidate.text) : null;
  const dynamicContextText = mergeDynamicContextTexts(
    instructionRewrite?.dynamicContextText,
    rootRewrite?.dynamicContextText,
  );
  const target = config.hooks.dynamicContextTarget;

  let rewrittenEnvelope = envelope;
  if (instructionRewrite?.changed) {
    rewrittenEnvelope = applyStablePrefixToInstructions({
      envelope: rewrittenEnvelope,
      dynamicContextTarget: target,
      mergeDynamicContextIntoInstructions: false,
    });
  }
  if (candidate && rootRewrite?.changed) {
    const nextCandidate = findRootPromptCandidate(rewrittenEnvelope.messages);
    if (nextCandidate) {
      rewrittenEnvelope = applyStablePrefixToMessage({
        envelope: rewrittenEnvelope,
        messageIndex: nextCandidate.index,
        dynamicContextTarget: target,
        mergeDynamicContextIntoMessage: false,
      });
      if (target === "developer" && dynamicContextText) {
        rewrittenEnvelope = insertDeveloperDynamicContextMessage({
          envelope: rewrittenEnvelope,
          dynamicContextText,
          afterMessageIndex: nextCandidate.index,
        });
      }
    }
  } else if (target === "developer" && dynamicContextText) {
    rewrittenEnvelope = insertDeveloperDynamicContextMessage({
      envelope: rewrittenEnvelope,
      dynamicContextText,
    });
  }

  const stablePromptParts = uniqueStablePromptParts([
    instructionRewrite?.canonicalText ?? instructionText,
    rootRewrite?.canonicalText ?? candidate?.text ?? "",
  ]);
  const nextPromptCacheKey = computeStablePromptCacheKey(envelope.model, stablePromptParts);
  const outboundPromptCacheKey = originalPromptCacheKey || nextPromptCacheKey;

  const nextMetadata = {
    ...(rewrittenEnvelope.metadata ?? {}),
    originalPromptCacheKey,
    frameworkStablePromptCacheKey: nextPromptCacheKey,
    promptCacheKey: outboundPromptCacheKey,
    promptCacheRetention: "24h",
  };

  return rewrittenEnvelope !== envelope || nextMetadata.promptCacheKey !== envelope.metadata?.promptCacheKey
    ? {
        ...rewrittenEnvelope,
        metadata: nextMetadata,
      }
    : envelope;
}
