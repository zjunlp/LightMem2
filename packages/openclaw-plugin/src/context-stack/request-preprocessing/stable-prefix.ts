/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from "node:crypto";
import {
  prependTextToContent,
  rewriteRootPromptForStablePrefix,
} from "./root-prompt-stabilizer.js";

export function normalizeText(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

const OPENCLAW_SENDER_METADATA_BLOCK_RE =
  /(?:^|\n{1,2})Sender\s+\(untrusted metadata\):\s*```json\s*[\s\S]*?```(?:\n{1,2}|$)/gi;
const OPENCLAW_SENDER_METADATA_DETECT_RE =
  /Sender\s+\(untrusted metadata\):\s*```json/gi;

function stripUntrustedSenderMetadata(text: string): string {
  const raw = String(text ?? "");
  const withoutMetadata = raw.replace(OPENCLAW_SENDER_METADATA_BLOCK_RE, "\n\n");
  return withoutMetadata.replace(/\n{3,}/g, "\n\n").trim();
}

function normalizeUserMessageText(text: string): string {
  return stripUntrustedSenderMetadata(String(text ?? ""))
    .replace(/^\[[^\]\n]{6,}\]\s*/u, "")
    .replace(/^(?:-\s*[A-Z][A-Z0-9_]*\s*:\s*[^\n]*\n)+/u, "")
    .trim();
}

export function normalizeTurnBindingMessage(text: string): string {
  return normalizeUserMessageText(String(text ?? "").trim()).trim();
}

export function extractInputText(input: any): string {
  if (typeof input === "string") return input;
  if (Array.isArray(input)) {
    return input
      .map((entry) => {
        if (!entry || typeof entry !== "object") return "";
        const content = (entry as any).content;
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
          return content
            .map((c: any) => {
              if (!c || typeof c !== "object") return "";
              if (typeof c.text === "string") return c.text;
              if (typeof c.content === "string") return c.content;
              return "";
            })
            .join("\n");
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function countSenderMetadataBlocks(value: any): number {
  const matches = String(extractInputText(value) ?? "").match(OPENCLAW_SENDER_METADATA_DETECT_RE);
  return matches ? matches.length : 0;
}

function normalizeContentNode(value: any): { value: any; changed: boolean } {
  if (typeof value === "string") {
    const next = normalizeUserMessageText(value);
    return { value: next, changed: next !== value };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const normalized = normalizeContentNode(item);
      if (normalized.changed) changed = true;
      return normalized.value;
    });
    return { value: next, changed };
  }
  if (!value || typeof value !== "object") {
    return { value, changed: false };
  }
  let changed = false;
  const next: Record<string, any> = Array.isArray(value) ? [] : { ...value };
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizeContentNode(child);
    if (normalized.changed) {
      changed = true;
      next[key] = normalized.value;
    }
  }
  return { value: changed ? next : value, changed };
}

function normalizeContentValue(value: any): { value: any; changed: boolean } {
  return normalizeContentNode(value);
}

function findDeveloperPromptText(input: any): string {
  if (!Array.isArray(input)) return "";
  const developer = input.find((item) => item && typeof item === "object" && String(item.role) === "developer");
  if (!developer) return "";
  return extractInputText([developer]);
}

function stripToolingSectionForKey(text: string): string {
  const raw = String(text ?? "");
  const markerA = "## Tooling";
  const markerB = "\nTOOLS.md does not control tool availability; it is user guidance for how to use external tools.";
  const start = raw.indexOf(markerA);
  if (start < 0) return raw;
  const end = raw.indexOf(markerB, start);
  if (end < 0) return raw;
  const toolingEnd = end + markerB.length;
  const before = raw.slice(0, start).trimEnd();
  const after = raw.slice(toolingEnd).trimStart();
  return [before, after].filter(Boolean).join("\n\n").trim();
}

function stripRuntimeTailForKey(text: string): string {
  return String(text ?? "")
    .replace(/(?:\n|^)-\s*WORKDIR:\s*[^\n\r]+/g, "")
    .replace(/(?:\n|^)-\s*AGENT_ID:\s*[^\n\r]+/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeStableText(input: string): string {
  return input
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "<UUID>")
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][0-9:.+\-Z]{6,}\b/g, "<TIMESTAMP>")
    .replace(/\b\d{10,}\b/g, "<LONGNUM>")
    .replace(/\s+/g, " ")
    .trim();
}

function computeStablePromptCacheKey(
  model: string,
  instructions: string,
  developerText: string,
): string {
  const seed = JSON.stringify({
    v: 3,
    model,
    instructions: "",
    developer: "",
  });
  const digest = createHash("sha256").update(seed).digest("hex").slice(0, 24);
  return `runtime-pfx-${digest}`;
}

function replaceContentWithText(content: any, nextText: string): any {
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
    next.unshift({ type: "input_text", text: nextText });
    return next;
  }
  if (content && typeof content === "object") {
    if (typeof (content as any).text === "string") return { ...content, text: nextText };
    if (typeof (content as any).content === "string") return { ...content, content: nextText };
  }
  return nextText;
}

export function rewritePayloadForStablePrefix(
  payload: any,
  model: string,
  options?: {
    dynamicContextTarget?: "developer" | "user";
    developerTextForKeyOverride?: string;
  },
): {
  promptCacheKey: string;
  userContentRewrites: number;
  senderMetadataBlocksBefore: number;
  senderMetadataBlocksAfter: number;
  developerTextForKey: string;
} {
  let userContentRewrites = 0;
  let senderMetadataBlocksBefore = 0;
  let senderMetadataBlocksAfter = 0;
  let dynamicContextText = "";
  const dynamicContextTarget = options?.dynamicContextTarget === "user" ? "user" : "developer";
  if (Array.isArray(payload?.input)) {
    payload.input = payload.input.map((item: any) => {
      if (!item || typeof item !== "object") return item;
      const role = String(item.role ?? "");
      if (role !== "user" && role !== "system") return item;
      if (item.__ecoclaw_replay_raw === true) return item;

      if (role === "system") {
        const contentText =
          typeof item.content === "string"
            ? String(item.content)
            : extractInputText([item]);
        const rewrite = rewriteRootPromptForStablePrefix(contentText);
        if (!rewrite.changed) return item;
        if (!dynamicContextText && rewrite.dynamicContextText) {
          dynamicContextText = rewrite.dynamicContextText;
        }
        senderMetadataBlocksBefore += countSenderMetadataBlocks(item.content);
        userContentRewrites += 1;
        const newContent = replaceContentWithText(item.content, rewrite.forwardedPromptText);
        const nextItem = {
          ...item,
          content: newContent,
        };
        senderMetadataBlocksAfter += countSenderMetadataBlocks(nextItem.content);
        return nextItem;
      }

      senderMetadataBlocksBefore += countSenderMetadataBlocks(item.content);
      const normalized = normalizeContentValue(item.content);
      if (!normalized.changed) {
        senderMetadataBlocksAfter += countSenderMetadataBlocks(item.content);
        return item;
      }
      userContentRewrites += 1;
      const nextItem = {
        ...item,
        content: normalized.value,
      };
      senderMetadataBlocksAfter += countSenderMetadataBlocks(nextItem.content);
      return nextItem;
    });

    if (dynamicContextText) {
      if (dynamicContextTarget === "user") {
        const userIndex = payload.input.findIndex((item: any) => item && typeof item === "object" && String(item.role) === "user");
        if (userIndex >= 0) {
          const userItem = payload.input[userIndex];
          const currentText = extractInputText([userItem]);
          if (!currentText.includes(dynamicContextText)) {
            payload.input[userIndex] = {
              ...userItem,
              role: "user",
              content: prependTextToContent(userItem?.content, dynamicContextText),
            };
            userContentRewrites += 1;
          }
        }
      } else {
        const developerIndex = payload.input.findIndex((item: any) => item && typeof item === "object" && String(item.role) === "developer");
        if (developerIndex >= 0) {
          const developerItem = payload.input[developerIndex];
          const currentText = extractInputText([developerItem]);
          if (!currentText.includes(dynamicContextText)) {
            const mergedText = `${normalizeText(currentText)}\n\n${normalizeText(dynamicContextText)}`;
            payload.input[developerIndex] = {
              ...developerItem,
              role: "developer",
              content: mergedText,
            };
            userContentRewrites += 1;
          }
        }
      }
    }
  }

  const developerTextForKey =
    typeof options?.developerTextForKeyOverride === "string" && options.developerTextForKeyOverride.trim().length > 0
      ? options.developerTextForKeyOverride
      : findDeveloperPromptText(payload?.input);
  const developerTextForKeyNormalized = stripRuntimeTailForKey(stripToolingSectionForKey(developerTextForKey));
  const stablePromptCacheKey = computeStablePromptCacheKey(
    model,
    String(payload?.instructions ?? ""),
    developerTextForKeyNormalized,
  );
  payload.prompt_cache_key = stablePromptCacheKey;
  return {
    promptCacheKey: stablePromptCacheKey,
    userContentRewrites,
    senderMetadataBlocksBefore,
    senderMetadataBlocksAfter,
    developerTextForKey: developerTextForKeyNormalized,
  };
}

export function estimatePayloadInputChars(input: any): number {
  try {
    return normalizeText(extractInputText(input)).length;
  } catch {
    return 0;
  }
}

export function findDeveloperAndPrimaryUser(input: any): {
  developerText: string;
  developerIndex: number;
  developerItem: any;
  userIndex: number;
  userItem: any | null;
} | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  let developerIndex = -1;
  let developerItem: any = null;
  let developerText = "";
  for (let i = 0; i < input.length; i += 1) {
    const item = input[i];
    if (!item || typeof item !== "object" || String((item as any).role) !== "developer") continue;
    const text =
      typeof (item as any).content === "string"
        ? String((item as any).content)
        : extractInputText([item]);
    if (!text.trim()) continue;
    developerIndex = i;
    developerItem = item;
    developerText = text;
    break;
  }
  if (developerIndex < 0 || !developerItem) return null;

  let userIndex = -1;
  for (let i = developerIndex + 1; i < input.length; i += 1) {
    const item = input[i];
    if (item && typeof item === "object" && String((item as any).role) === "user") {
      userIndex = i;
      break;
    }
  }
  if (userIndex < 0) {
    userIndex = input.findIndex((item) => item && typeof item === "object" && String((item as any).role) === "user");
  }
  const userItem = userIndex >= 0 ? input[userIndex] : null;
  return { developerText, developerIndex, developerItem, userIndex, userItem };
}
