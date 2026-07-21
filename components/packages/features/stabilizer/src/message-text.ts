/* eslint-disable @typescript-eslint/no-explicit-any */

export {
  extractContentText,
  prependTextToContent,
  replaceContentText,
} from "@tokenpilot/kernel";
import {
  extractContentText,
} from "@tokenpilot/kernel";

const SENDER_METADATA_BLOCK_RE =
  /(?:^|\n{1,2})Sender\s+\(untrusted metadata\):\s*```json\s*[\s\S]*?```(?:\n{1,2}|$)/gi;
const ABSOLUTE_PATH_TOKEN_RE = /(?:[A-Za-z]:[\\/]|\/)[^\s"'`)\]}]+/g;
const ISO_TIMESTAMP_RE = /\b\d{4}-\d{2}-\d{2}(?:[T ][0-9:.+\-Z]{2,})\b/g;
const UUID_TOKEN_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const LONG_NUMBER_TOKEN_RE = /\b\d{10,}\b/g;
const VOLATILE_RUNTIME_KEY_RE = /\b(agent|session(?:_id)?|request(?:_id)?|thread(?:_id)?|conversation(?:_id)?|trace(?:_id)?|run(?:_id)?|job(?:_id)?|task(?:_id)?|sandbox(?:_id)?)=([^\s|,;]+)/gi;
const PURE_VOLATILE_RUNTIME_KEY_RE = /\b(agent|session(?:_id)?|request(?:_id)?|thread(?:_id)?|conversation(?:_id)?|trace(?:_id)?|run(?:_id)?|job(?:_id)?|task(?:_id)?|sandbox(?:_id)?)=([^\s|,;]+)/i;
const VOLATILE_METADATA_LINE_RE_LIST = [
  /^(?:-?\s*)Current date:\s*.+$/i,
  /^(?:-?\s*)Current time:\s*.+$/i,
  /^(?:-?\s*)Today(?:'s)? date:\s*.+$/i,
  /^(?:-?\s*)Request ID:\s*.+$/i,
  /^(?:-?\s*)Session ID:\s*.+$/i,
  /^(?:-?\s*)Thread ID:\s*.+$/i,
  /^(?:-?\s*)Conversation ID:\s*.+$/i,
  /^(?:-?\s*)Trace ID:\s*.+$/i,
  /^(?:-?\s*)Run ID:\s*.+$/i,
  /^(?:-?\s*)Job ID:\s*.+$/i,
  /^(?:-?\s*)Task ID:\s*.+$/i,
  /^(?:-?\s*)(?:Seen|Generated|Created|Updated)\s+at\b.*$/i,
  /^(?:-?\s*)Timestamp:\s*.+$/i,
];

const VOLATILE_METADATA_LINE_PATTERNS: Array<{
  pattern: RegExp;
  placeholder: string;
}> = [
  { pattern: /^(-?\s*Current date:\s*).+$/gim, placeholder: "<CURRENT_DATE>" },
  { pattern: /^(-?\s*Current time:\s*).+$/gim, placeholder: "<CURRENT_TIME>" },
  { pattern: /^(-?\s*Today(?:'s)? date:\s*).+$/gim, placeholder: "<CURRENT_DATE>" },
  { pattern: /^(-?\s*Request ID:\s*).+$/gim, placeholder: "<REQUEST_ID>" },
  { pattern: /^(-?\s*Session ID:\s*).+$/gim, placeholder: "<SESSION_ID>" },
  { pattern: /^(-?\s*Thread ID:\s*).+$/gim, placeholder: "<THREAD_ID>" },
  { pattern: /^(-?\s*Conversation ID:\s*).+$/gim, placeholder: "<CONVERSATION_ID>" },
  { pattern: /^(-?\s*Trace ID:\s*).+$/gim, placeholder: "<TRACE_ID>" },
  { pattern: /^(-?\s*Run ID:\s*).+$/gim, placeholder: "<RUN_ID>" },
  { pattern: /^(-?\s*Job ID:\s*).+$/gim, placeholder: "<JOB_ID>" },
  { pattern: /^(-?\s*Task ID:\s*).+$/gim, placeholder: "<TASK_ID>" },
  { pattern: /^(-?\s*(?:Seen|Generated|Created|Updated)\s+at\b\s*).+$/gim, placeholder: "<TIMESTAMP>" },
  { pattern: /^(-?\s*Timestamp:\s*).+$/gim, placeholder: "<TIMESTAMP>" },
];

export function normalizeText(input: string): string {
  return String(input ?? "").replace(/\s+/g, " ").trim();
}

function trimTrailingPathPunctuation(path: string): { path: string; trailing: string } {
  let value = String(path ?? "");
  let trailing = "";
  while (/[.,;:!?]$/.test(value)) {
    trailing = value.slice(-1) + trailing;
    value = value.slice(0, -1);
  }
  return { path: value, trailing };
}

function normalizePathSlashes(path: string): string {
  return String(path ?? "").replace(/\\/g, "/");
}

function normalizePathPrefix(path: string, prefix: string, label: string): string | null {
  const normalizedPath = normalizePathSlashes(path);
  const normalizedPrefix = normalizePathSlashes(prefix).replace(/\/+$/g, "");
  if (!normalizedPrefix) return null;
  if (normalizedPath === normalizedPrefix) return label;
  if (normalizedPath.startsWith(`${normalizedPrefix}/`)) {
    return `${label}${normalizedPath.slice(normalizedPrefix.length)}`;
  }
  return null;
}

function stablePathTail(path: string, segments = 2): string {
  const parts = normalizePathSlashes(path).split("/").filter(Boolean);
  if (parts.length === 0) return "";
  return parts.slice(-Math.min(parts.length, segments)).join("/");
}

function normalizeVolatileMetadataText(text: string): string {
  let normalized = String(text ?? "");
  for (const { pattern, placeholder } of VOLATILE_METADATA_LINE_PATTERNS) {
    normalized = normalized.replace(pattern, (_match: string, prefix: string) => `${prefix}${placeholder}`);
  }
  normalized = normalized.replace(VOLATILE_RUNTIME_KEY_RE, (_match: string, key: string, value: string) => {
    const rawValue = String(value ?? "").trim();
    if (/^<[^>]+>$/.test(rawValue)) {
      return `${key}=${rawValue}`;
    }
    const upperKey = String(key ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, "_");
    return `${key}=<${upperKey}>`;
  });
  normalized = normalized.replace(ISO_TIMESTAMP_RE, "<TIMESTAMP>");
  normalized = normalized.replace(UUID_TOKEN_RE, "<UUID>");
  normalized = normalized.replace(LONG_NUMBER_TOKEN_RE, "<LONG_NUMBER>");
  return normalized;
}

function collapseExtraBlankLines(text: string): string {
  return String(text ?? "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isVolatileMetadataLine(line: string): boolean {
  const trimmed = String(line ?? "").trim();
  if (!trimmed) return false;
  return VOLATILE_METADATA_LINE_RE_LIST.some((pattern) => pattern.test(trimmed));
}

function isPureVolatileKeyValueSegment(segment: string): boolean {
  const trimmed = String(segment ?? "").trim();
  if (!trimmed) return false;
  const withoutLabel = trimmed.replace(/^[A-Za-z][A-Za-z0-9 _-]{0,32}:\s*/, "");
  return withoutLabel
    .split(/\s*\|\s*|\s*,\s*/)
    .filter(Boolean)
    .every((part) => PURE_VOLATILE_RUNTIME_KEY_RE.test(part.trim()) || /^[A-Za-z0-9_]+=<[^>]+>$/.test(part.trim()));
}

function isStableRuntimeHeaderSegment(segment: string): boolean {
  const trimmed = String(segment ?? "").trim();
  if (!trimmed) return false;
  return /^Runtime:\s*agent=/i.test(trimmed) || /^Your working directory is:/i.test(trimmed);
}

function splitMixedVolatileLine(line: string): {
  stableLine: string;
  dynamicParts: string[];
} | null {
  const raw = String(line ?? "");
  if (!raw.includes("|")) return null;
  const segments = raw.split("|").map((segment) => segment.trim()).filter(Boolean);
  if (segments.length < 2) return null;
  const stableParts: string[] = [];
  const dynamicParts: string[] = [];
  for (const segment of segments) {
    if (isStableRuntimeHeaderSegment(segment)) {
      stableParts.push(segment);
      continue;
    }
    if (isPureVolatileKeyValueSegment(segment) || isVolatileMetadataLine(segment)) {
      dynamicParts.push(segment);
    } else {
      stableParts.push(segment);
    }
  }
  if (dynamicParts.length === 0 || stableParts.length === 0) return null;
  return {
    stableLine: stableParts.join(" | "),
    dynamicParts,
  };
}

function extractVolatileDynamicLines(text: string): {
  stableText: string;
  dynamicLines: string[];
} {
  const dynamicLines: string[] = [];
  const stableLines: string[] = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      stableLines.push(line);
      continue;
    }
    const mixed = splitMixedVolatileLine(trimmed);
    if (mixed) {
      stableLines.push(mixed.stableLine);
      for (const part of mixed.dynamicParts) {
        if (!dynamicLines.includes(part)) dynamicLines.push(part);
      }
      continue;
    }
    if (isVolatileMetadataLine(trimmed) || isPureVolatileKeyValueSegment(trimmed)) {
      dynamicLines.push(trimmed);
      continue;
    }
    stableLines.push(line);
  }
  return {
    stableText: collapseExtraBlankLines(stableLines.join("\n")),
    dynamicLines,
  };
}

export function normalizeStablePrefixText(
  text: string,
  options?: {
    workdir?: string;
    homeDir?: string;
  },
): string {
  const raw = String(text ?? "");
  if (!raw.trim()) return raw;
  const homeDir = options?.homeDir ?? process.env.HOME ?? process.env.USERPROFILE ?? "";
  const withoutVolatileMetadata = normalizeVolatileMetadataText(raw);
  return withoutVolatileMetadata.replace(ABSOLUTE_PATH_TOKEN_RE, (absolutePath: string, offset: number, source: string) => {
    const previousChar = offset > 0 ? source[offset - 1] : "";
    if (previousChar && /[A-Za-z0-9_.-]/.test(previousChar)) {
      return absolutePath;
    }

    const { path, trailing } = trimTrailingPathPunctuation(absolutePath);
    const normalized = normalizePathSlashes(path);
    if (!normalized) return absolutePath;
    if (normalized.includes("://")) return absolutePath;

    const workdirReplacement = options?.workdir
      ? normalizePathPrefix(normalized, options.workdir, "<WORKDIR>")
      : null;
    if (workdirReplacement) return `${workdirReplacement}${trailing}`;

    const codexSkillMarker = "/.codex/skills/";
    const codexSkillIndex = normalized.indexOf(codexSkillMarker);
    if (codexSkillIndex >= 0) {
      const suffix = normalized.slice(codexSkillIndex + codexSkillMarker.length);
      return `<CODEX_SKILLS>/${suffix}${trailing}`;
    }

    const homeReplacement = homeDir
      ? normalizePathPrefix(normalized, homeDir, "<HOME>")
      : null;
    if (homeReplacement) return `${homeReplacement}${trailing}`;

    const nodeModulesMarker = "/node_modules/";
    const nodeModulesIndex = normalized.indexOf(nodeModulesMarker);
    if (nodeModulesIndex >= 0) {
      const suffix = normalized.slice(nodeModulesIndex + nodeModulesMarker.length);
      return `<NODE_MODULES>/${suffix}${trailing}`;
    }

    const tail = stablePathTail(normalized, normalized.split("/").includes(".codex") ? 3 : 2);
    return `${tail ? `<ABS_PATH>/${tail}` : "<ABS_PATH>"}${trailing}`;
  });
}

function stripUntrustedSenderMetadata(text: string): string {
  const raw = String(text ?? "");
  const withoutMetadata = raw.replace(SENDER_METADATA_BLOCK_RE, "\n\n");
  return withoutMetadata.replace(/\n{3,}/g, "\n\n").trim();
}

export function normalizeUserMessageText(text: string): string {
  return stripUntrustedSenderMetadata(String(text ?? ""))
    .replace(/^\[[^\]\n]{6,}\]\s*/u, "")
    .replace(/^(?:-\s*[A-Z][A-Z0-9_]*\s*:\s*[^\n]*\n)+/u, "")
    .trim();
}

function relocateToolingSectionToEnd(text: string): string {
  const markerA = "## Tooling";
  const markerB = "\nTOOLS.md does not control tool availability; it is user guidance for how to use external tools.";
  const start = text.indexOf(markerA);
  if (start < 0) return text;
  const end = text.indexOf(markerB, start);
  if (end < 0) return text;
  const toolingEnd = end + markerB.length;
  const tooling = text.slice(start, toolingEnd).trim();
  const before = text.slice(0, start).trimEnd();
  const after = text.slice(toolingEnd).trimStart();
  const body = [before, after].filter(Boolean).join("\n\n").trim();
  if (!body) return tooling;
  return `${body}\n\n${tooling}`;
}

export type StablePrefixTextRewrite = {
  canonicalText: string;
  forwardedText: string;
  dynamicContextText: string;
  changed: boolean;
  workdir?: string;
  agentId?: string;
};

export function rewriteTextForStablePrefix(promptText: string): StablePrefixTextRewrite {
  const raw = String(promptText ?? "");
  if (!raw.trim()) {
    return {
      canonicalText: raw,
      forwardedText: raw,
      dynamicContextText: "",
      changed: false,
    };
  }

  const workdirMatch = raw.match(/Your working directory is:\s*([^\n\r]+)/i);
  const runtimeAgentMatch = raw.match(/Runtime:\s*agent=([^|\n\r]+)/i);
  const workdir = workdirMatch?.[1]?.trim();
  const agentId = runtimeAgentMatch?.[1]?.trim();
  const extracted = extractVolatileDynamicLines(raw);
  const forwardedText = extracted.dynamicLines.length > 0 ? extracted.stableText : raw;

  let canonical = forwardedText;
  canonical = relocateToolingSectionToEnd(canonical);
  if (workdir) {
    canonical = canonical.split(workdir).join("<WORKDIR>");
  }
  canonical = canonical.replace(/(Runtime:\s*agent=)[^|\n\r]+(\s*\|?)/gi, (_match, prefix: string, suffix: string) => {
    const normalizedSuffix = suffix.includes("|") ? " |" : "";
    return `${prefix}<AGENT_ID>${normalizedSuffix}`;
  });
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
  canonical = normalizeStablePrefixText(canonical, { workdir });

  const dynamicLines: string[] = [];
  if (workdir) dynamicLines.push(`- WORKDIR: ${workdir}`);
  if (agentId) dynamicLines.push(`- AGENT_ID: ${agentId}`);
  for (const line of extracted.dynamicLines) {
    if (!dynamicLines.includes(line)) dynamicLines.push(line);
  }
  const dynamicContextText = dynamicLines.join("\n");

  return {
    canonicalText: canonical,
    forwardedText,
    dynamicContextText,
    changed: canonical !== raw || forwardedText !== raw || dynamicContextText.length > 0,
    workdir,
    agentId,
  };
}
