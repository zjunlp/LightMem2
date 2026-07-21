export type ToolPayloadContentType =
  | "json_array"
  | "json_object"
  | "search_results"
  | "log_output"
  | "diff_output"
  | "code_like"
  | "markdown_doc"
  | "readme_doc"
  | "task_doc"
  | "blob"
  | "plain_text";

export type ToolPayloadClassification = {
  contentType: ToolPayloadContentType;
  reason: string;
};

export type ToolPayloadHint = {
  toolName?: string;
  fieldName?: string;
  path?: string;
  payloadKind?: "stdout" | "stderr" | "json" | "blob";
  readState?: "fresh" | "superseded" | "stale";
};

const SEARCH_LINE_RE = /^(.+?):(\d+)(?::|-)(.*)$/;
const STACK_TRACE_RE = /^\s*(at\s+\S+\s+\(|Traceback \(most recent call last\):|Caused by:|File ".*", line \d+)/;
const LOG_SIGNAL_RE = /\b(error|warn(?:ing)?|failed|exception|traceback|panic|fatal)\b/i;
const LOG_LINE_RE = /(\b(INFO|DEBUG|TRACE|WARN|WARNING|ERROR|FAIL|FAILED|FATAL|CRITICAL)\b|^\s*\d{4}-\d{2}-\d{2}|^\s*\[\d{2}:\d{2}:\d{2}\]|^\s*PASSED\b|^\s*FAILED\b|^npm ERR!|^yarn error|^cargo error)/i;
const CODE_FENCE_RE = /```[\s\S]*?```/;
const CODE_KEYWORD_RE = /\b(function|class|def|import|from|const|let|var|return|if|else|for|while|async|await|interface|type)\b/;
const DIFF_HEADER_RE = /^(diff --git|diff --combined |diff --cc |--- a\/|\+\+\+ b\/|@@\s+-\d+,\d+\s+\+\d+,\d+\s+@@|@@@+\s+-\d+(?:,\d+)?\s+(?:-\d+(?:,\d+)?\s+)+\+\d+(?:,\d+)?\s+@@@+)/;
const DIFF_CHANGE_RE = /^[+-][^+-]/;
const MARKDOWN_HEADING_RE = /^\s{0,3}#{1,6}\s+\S+/;
const MARKDOWN_LIST_RE = /^\s*(?:[-*+]|\d+\.)\s+\S+/;
const MARKDOWN_TABLE_RE = /^\s*\|.+\|\s*$/;
const TASK_DOC_KEYWORD_RE = /\b(todo|task|plan|next step|acceptance criteria|deliverable|milestone|checklist)\b/i;

const CODE_EXTENSIONS = new Set([
  ".py",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".rb",
  ".php",
  ".swift",
  ".kt",
  ".scala",
  ".sh",
  ".bash",
  ".zsh",
  ".sql",
]);

function looksLikeCodePath(path: string | undefined): boolean {
  if (!path) return false;
  const normalized = path.trim().toLowerCase();
  if (!normalized) return false;
  for (const ext of CODE_EXTENSIONS) {
    if (normalized.endsWith(ext)) return true;
  }
  return false;
}

function looksLikeMarkdown(lines: string[]): boolean {
  if (lines.length < 3) return false;
  const headingCount = countMatchingLines(lines, MARKDOWN_HEADING_RE);
  const listCount = countMatchingLines(lines, MARKDOWN_LIST_RE);
  const tableCount = countMatchingLines(lines, MARKDOWN_TABLE_RE);
  return headingCount >= 1 || listCount >= Math.min(3, Math.ceil(lines.length * 0.25)) || tableCount >= 2;
}

function looksLikeReadme(path: string | undefined, text: string): boolean {
  const normalizedPath = path?.trim().toLowerCase() ?? "";
  if (/(^|\/)readme(\.[a-z0-9_-]+)?$/i.test(normalizedPath)) return true;
  return /^#\s+.+/m.test(text) && /installation|usage|getting started|overview|configuration/i.test(text);
}

function looksLikeTaskDoc(path: string | undefined, text: string, lines: string[]): boolean {
  const normalizedPath = path?.trim().toLowerCase() ?? "";
  if (normalizedPath.includes("task") || normalizedPath.includes("plan") || normalizedPath.includes("spec")) {
    return true;
  }
  const keywordHits = countMatchingLines(lines, TASK_DOC_KEYWORD_RE);
  const markdownLike = looksLikeMarkdown(lines);
  const hasTaskHeading = lines.some((line) => /^\s{0,3}#{1,6}\s+.*\b(task|plan|checklist|milestone|acceptance)\b/i.test(line));
  return (markdownLike || hasTaskHeading) && keywordHits >= Math.min(2, Math.ceil(lines.length * 0.15));
}

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isLikelyBlob(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/^data:[^;]+;base64,[A-Za-z0-9+/=\s]+$/i.test(trimmed)) return true;
  if (/^[A-Za-z0-9+/=\s]{512,}$/.test(trimmed.replace(/\n/g, ""))) return true;
  if (/^[A-Fa-f0-9\s]{512,}$/.test(trimmed.replace(/\n/g, ""))) return true;
  return false;
}

function countMatchingLines(lines: string[], re: RegExp): number {
  let count = 0;
  for (const line of lines) {
    if (re.test(line)) count += 1;
  }
  return count;
}

function looksLikeSearchResults(lines: string[]): boolean {
  if (lines.length < 3) return false;
  let matched = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!SEARCH_LINE_RE.test(trimmed)) continue;
    if (STACK_TRACE_RE.test(trimmed)) continue;
    if (/^\s*Error:/i.test(trimmed)) continue;
    matched += 1;
  }
  return matched >= Math.min(3, Math.ceil(lines.length * 0.4));
}

function looksLikeLogs(lines: string[]): boolean {
  if (lines.length < 4) return false;
  const signalCount = countMatchingLines(lines, LOG_SIGNAL_RE);
  const stackCount = countMatchingLines(lines, STACK_TRACE_RE);
  const logLineCount = countMatchingLines(lines, LOG_LINE_RE);
  return signalCount >= 2 || stackCount >= 2 || logLineCount >= Math.min(4, Math.ceil(lines.length * 0.4));
}

function looksLikeDiff(lines: string[]): boolean {
  if (lines.length < 3) return false;
  const headerCount = countMatchingLines(lines, DIFF_HEADER_RE);
  const changeCount = countMatchingLines(lines, DIFF_CHANGE_RE);
  return headerCount >= 1 && changeCount >= 2;
}

function looksLikeCode(text: string, lines: string[]): boolean {
  if (CODE_FENCE_RE.test(text)) return true;
  if (CODE_KEYWORD_RE.test(text) && lines.length >= 4) return true;
  const indentedLines = lines.filter((line) => /^\s{2,}\S/.test(line)).length;
  return indentedLines >= Math.min(6, Math.ceil(lines.length * 0.5));
}

export function classifyToolPayloadContent(text: string): ToolPayloadClassification {
  return classifyToolPayloadContentWithHint(text);
}

export function classifyToolPayloadContentWithHint(
  text: string,
  hint?: ToolPayloadHint,
): ToolPayloadClassification {
  const trimmed = text.trim();
  if (!trimmed) {
    return { contentType: "plain_text", reason: "empty" };
  }

  const toolName = hint?.toolName?.trim().toLowerCase();
  const fieldName = hint?.fieldName?.trim().toLowerCase();
  const payloadKind = hint?.payloadKind;
  const normalizedPath = hint?.path?.trim();

  if (payloadKind === "blob") {
    return { contentType: "blob", reason: "payload_kind_blob" };
  }
  if (payloadKind === "stderr") {
    const lines = trimmed.split("\n").filter((line) => line.length > 0);
    if (looksLikeLogs(lines)) {
      return { contentType: "log_output", reason: "stderr_log_hint" };
    }
  }
  if (toolName === "read" || toolName === "file_read") {
    const lines = trimmed.split("\n").filter((line) => line.length > 0);
    if (looksLikeCodePath(hint?.path)) {
      return { contentType: "code_like", reason: "read_path_code_hint" };
    }
    if (looksLikeReadme(normalizedPath, trimmed)) {
      return { contentType: "readme_doc", reason: "readme_path_or_content_hint" };
    }
    if (looksLikeTaskDoc(normalizedPath, trimmed, lines)) {
      return { contentType: "task_doc", reason: "task_doc_path_or_content_hint" };
    }
    if (looksLikeMarkdown(lines)) {
      return { contentType: "markdown_doc", reason: "markdown_structure_hint" };
    }
    if (looksLikeCode(trimmed, lines)) {
      return { contentType: "code_like", reason: "read_code_hint" };
    }
  }
  if (toolName === "git_diff" || toolName === "diff") {
    return { contentType: "diff_output", reason: "tool_name_diff_hint" };
  }
  if (toolName === "grep" || toolName === "rg" || toolName === "search") {
    return { contentType: "search_results", reason: "tool_name_search_hint" };
  }
  if (
    toolName === "web_fetch" ||
    toolName === "web_search" ||
    toolName === "tavily_search" ||
    fieldName === "output" ||
    fieldName === "result"
  ) {
    const parsed = tryParseJson(trimmed);
    if (Array.isArray(parsed)) {
      return { contentType: "json_array", reason: "tool_json_hint_array" };
    }
    if (parsed && typeof parsed === "object") {
      return { contentType: "json_object", reason: "tool_json_hint_object" };
    }
  }

  if (isLikelyBlob(trimmed)) {
    return { contentType: "blob", reason: "blob_signature" };
  }

  const parsed = tryParseJson(trimmed);
  if (Array.isArray(parsed)) {
    return { contentType: "json_array", reason: "json_parse_array" };
  }
  if (parsed && typeof parsed === "object") {
    return { contentType: "json_object", reason: "json_parse_object" };
  }

  const lines = trimmed.split("\n").filter((line) => line.length > 0);
  const searchLike = looksLikeSearchResults(lines);
  const logLike = looksLikeLogs(lines);
  const diffLike = looksLikeDiff(lines);

  if (diffLike) {
    return { contentType: "diff_output", reason: "diff_pattern" };
  }
  if (searchLike && !countMatchingLines(lines, STACK_TRACE_RE)) {
    return { contentType: "search_results", reason: "search_line_pattern" };
  }
  if (logLike) {
    return { contentType: "log_output", reason: "log_signal_pattern" };
  }
  if (searchLike) {
    return { contentType: "search_results", reason: "search_line_pattern" };
  }
  if (looksLikeReadme(normalizedPath, trimmed)) {
    return { contentType: "readme_doc", reason: "readme_content_pattern" };
  }
  if (looksLikeTaskDoc(normalizedPath, trimmed, lines)) {
    return { contentType: "task_doc", reason: "task_doc_content_pattern" };
  }
  if (looksLikeMarkdown(lines)) {
    return { contentType: "markdown_doc", reason: "markdown_structure_pattern" };
  }
  if (looksLikeCode(trimmed, lines)) {
    return { contentType: "code_like", reason: "code_structure_pattern" };
  }

  return { contentType: "plain_text", reason: "fallback_plain_text" };
}
