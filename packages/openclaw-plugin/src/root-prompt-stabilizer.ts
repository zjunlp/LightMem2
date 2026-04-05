/* eslint-disable @typescript-eslint/no-explicit-any */

export type RootPromptRewrite = {
  canonicalPromptText: string;
  forwardedPromptText: string;
  dynamicContextText: string;
  changed: boolean;
  workdir?: string;
  agentId?: string;
};

function extractContentText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((entry) => {
        if (!entry || typeof entry !== "object") return "";
        if (typeof entry.text === "string") return entry.text;
        if (typeof entry.content === "string") return entry.content;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (!content || typeof content !== "object") return "";
  if (typeof content.text === "string") return content.text;
  if (typeof content.content === "string") return content.content;
  return "";
}

function replaceContentText(content: any, nextText: string): any {
  if (typeof content === "string") return nextText;
  if (Array.isArray(content)) {
    const next = content.map((entry) => (entry && typeof entry === "object" ? { ...entry } : entry));
    for (let i = 0; i < next.length; i += 1) {
      const entry = next[i];
      if (!entry || typeof entry !== "object") continue;
      if (typeof (entry as any).text === "string") {
        (entry as any).text = nextText;
        return next;
      }
      if (typeof (entry as any).content === "string") {
        (entry as any).content = nextText;
        return next;
      }
    }
    next.unshift({ type: "text", text: nextText });
    return next;
  }
  if (content && typeof content === "object") {
    if (typeof content.text === "string") {
      return { ...content, text: nextText };
    }
    if (typeof content.content === "string") {
      return { ...content, content: nextText };
    }
  }
  return nextText;
}

export function prependTextToContent(content: any, extraText: string): any {
  const extra = String(extraText ?? "").trim();
  if (!extra) return content;
  if (typeof content === "string") {
    return content.trim().length > 0 ? `${extra}\n\n${content}` : extra;
  }
  if (Array.isArray(content)) {
    const next = content.map((item) => (item && typeof item === "object" ? { ...item } : item));
    for (let i = 0; i < next.length; i += 1) {
      const item = next[i];
      if (!item || typeof item !== "object") continue;
      if (typeof (item as any).text === "string") {
        (item as any).text = (item as any).text.trim().length > 0
          ? `${extra}\n\n${String((item as any).text)}`
          : extra;
        return next;
      }
      if (typeof (item as any).content === "string") {
        (item as any).content = (item as any).content.trim().length > 0
          ? `${extra}\n\n${String((item as any).content)}`
          : extra;
        return next;
      }
    }
    next.unshift({ type: "input_text", text: extra });
    return next;
  }
  return extra;
}

export function rewriteRootPromptForStablePrefix(promptText: string): RootPromptRewrite {
  const raw = String(promptText ?? "");
  if (!raw.trim()) {
    return {
      canonicalPromptText: raw,
      forwardedPromptText: raw,
      dynamicContextText: "",
      changed: false,
    };
  }
  const workdirMatch = raw.match(/Your working directory is:\s*([^\n\r]+)/i);
  const runtimeAgentMatch = raw.match(/Runtime:\s*agent=([^|\n\r]+)/i);
  const workdir = workdirMatch?.[1]?.trim();
  const agentId = runtimeAgentMatch?.[1]?.trim();

  let canonical = raw;
  if (workdir) {
    canonical = canonical.split(workdir).join("<WORKDIR>");
  }
  canonical = canonical.replace(/(Runtime:\s*agent=)[^|\n\r]+/gi, "$1<AGENT_ID>");
  canonical = canonical.replace(
    /^##\s+<WORKDIR>[\\/]+([^\\/\n\r]+)$/gm,
    "## $1",
  );
  canonical = canonical.replace(
    /^##\s+(?:[A-Za-z]:[\\/]|\/)[^\n\r]*[\\/]+([^\\/\n\r]+)$/gm,
    "## $1",
  );
  canonical = canonical.replace(
    /(\[MISSING\]\s+Expected at:\s*)<WORKDIR>[\\/]+([^\\/\n\r]+)/g,
    "$1$2",
  );
  canonical = canonical.replace(
    /(\[MISSING\]\s+Expected at:\s*)(?:[A-Za-z]:[\\/]|\/)[^\n\r]*[\\/]+([^\\/\n\r]+)/g,
    "$1$2",
  );

  const dynamicLines: string[] = [];
  if (workdir) dynamicLines.push(`- WORKDIR: ${workdir}`);
  if (agentId) dynamicLines.push(`- AGENT_ID: ${agentId}`);
  const dynamicTail =
    dynamicLines.length > 0
      ? `\n${dynamicLines.join("\n")}`
      : "";

  return {
    canonicalPromptText: canonical,
    forwardedPromptText: canonical,
    dynamicContextText: dynamicTail.trim(),
    changed: canonical !== raw || dynamicTail.length > 0,
    workdir,
    agentId,
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
    content: replaceContentText((systemItem ?? nextMessages[systemIndex])?.content, rewrite.forwardedPromptText),
  };
  if (rewrite.dynamicContextText && userIndex >= 0) {
    const userItem = nextMessages[userIndex];
    nextMessages[userIndex] = {
      ...(userItem ?? {}),
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
