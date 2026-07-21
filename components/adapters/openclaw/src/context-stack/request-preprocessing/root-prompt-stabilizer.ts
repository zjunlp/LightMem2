/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  extractContentText,
  prependTextToContent,
  replaceContentText,
  rewriteTextForStablePrefix,
} from "@lightmem2/stabilizer";

export type RootPromptRewrite = {
  canonicalPromptText: string;
  forwardedPromptText: string;
  dynamicContextText: string;
  changed: boolean;
  workdir?: string;
  agentId?: string;
};

function normalizeOpenClawAgentSeparator(text: string): string {
  return String(text ?? "").replace(/agent=<AGENT_ID>\s+\|/g, "agent=<AGENT_ID>|");
}

export { prependTextToContent };

export function rewriteRootPromptForStablePrefix(promptText: string): RootPromptRewrite {
  const rewrite = rewriteTextForStablePrefix(promptText);
  return {
    canonicalPromptText: normalizeOpenClawAgentSeparator(rewrite.canonicalText),
    forwardedPromptText: normalizeOpenClawAgentSeparator(rewrite.forwardedText),
    dynamicContextText: rewrite.dynamicContextText,
    changed: rewrite.changed,
    workdir: rewrite.workdir,
    agentId: rewrite.agentId,
  };
}

export function applyRootPromptRewriteToChatMessages(messages: any[]): {
  messages: any[];
  rewrite: RootPromptRewrite | null;
  changed: boolean;
  systemIndex: number;
  userIndex: number;
} {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages, rewrite: null, changed: false, systemIndex: -1, userIndex: -1 };
  }

  let systemIndex = -1;
  let systemItem: any = null;
  let systemText = "";
  for (let i = 0; i < messages.length; i += 1) {
    const item = messages[i];
    if (!item || typeof item !== "object" || String((item as any).role) !== "system") continue;
    const text = extractContentText((item as any).content);
    if (!text.trim()) continue;
    systemIndex = i;
    systemItem = item;
    systemText = text;
    break;
  }
  if (systemIndex < 0 || !systemItem) {
    return { messages, rewrite: null, changed: false, systemIndex: -1, userIndex: -1 };
  }

  let userIndex = -1;
  for (let i = systemIndex + 1; i < messages.length; i += 1) {
    const item = messages[i];
    if (item && typeof item === "object" && String((item as any).role) === "user") {
      userIndex = i;
      break;
    }
  }
  if (userIndex < 0) {
    userIndex = messages.findIndex((item) => item && typeof item === "object" && String((item as any).role) === "user");
  }

  const rewrite = rewriteRootPromptForStablePrefix(systemText);
  if (!rewrite.changed) {
    return { messages, rewrite, changed: false, systemIndex, userIndex };
  }

  const nextMessages = messages.map((item) => (item && typeof item === "object" ? { ...item } : item));
  nextMessages[systemIndex] = {
    ...(systemItem ?? nextMessages[systemIndex]),
    role: "system",
    content: replaceContentText(
      (systemItem ?? nextMessages[systemIndex])?.content,
      rewrite.dynamicContextText
        ? `${rewrite.forwardedPromptText}\n\n${rewrite.dynamicContextText}`
        : rewrite.forwardedPromptText,
    ),
  };
  if (userIndex >= 0 && rewrite.dynamicContextText) {
    const userItem = nextMessages[userIndex];
    nextMessages[userIndex] = {
      ...userItem,
      role: "user",
      content: prependTextToContent(userItem?.content, rewrite.dynamicContextText),
    };
  }
  return {
    messages: nextMessages,
    rewrite,
    changed: true,
    systemIndex,
    userIndex,
  };
}
