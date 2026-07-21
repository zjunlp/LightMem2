import type { ContextSegment } from "@tokenpilot/kernel";
import type { ReductionPassHandler } from "../reduction/types.js";

type HtmlSlimmingOptions = {
  enabled?: boolean;
  attributeWhitelist?: string[];
};

const DEFAULT_ATTRIBUTES = [
  "href",
  "src",
  "alt",
  "title",
  "name",
  "role",
  "target",
  "rel",
  "aria-label",
];

const attributeRegex = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+)))?/g;

const resolveOptions = (input?: Record<string, unknown>): HtmlSlimmingOptions => {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  return {
    enabled: obj.enabled !== false,
    attributeWhitelist: Array.isArray(obj.attributeWhitelist)
      ? obj.attributeWhitelist.filter((value) => typeof value === "string").map((value) => value.toLowerCase())
      : DEFAULT_ATTRIBUTES,
  };
};

const isHtmlSegment = (text: string): boolean => /<\/?[a-zA-Z][^>]*>/.test(text);

const stripScriptStyles = (value: string): string =>
  value
    .replace(/<!--([\s\S]*?)-->/g, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");

const sanitizeAttributes = (attrs: string, whitelist: Set<string>): string => {
  const matches: string[] = [];
  let match: RegExpExecArray | null;
  attributeRegex.lastIndex = 0;
  while ((match = attributeRegex.exec(attrs))) {
    const name = match[1];
    const lower = name.toLowerCase();
    if (!whitelist.has(lower)) continue;
    const value = match[2] ?? match[3] ?? match[4];
    if (value !== undefined) {
      const safe = value.replace(/"/g, "&quot;");
      matches.push(`${name}="${safe}"`);
    } else {
      matches.push(name);
    }
  }
  return matches.length > 0 ? " " + matches.join(" ") : "";
};

const sanitizeHtml = (text: string, whitelist: Set<string>): string => {
  const cleaned = stripScriptStyles(text);
  return cleaned.replace(/<([a-zA-Z0-9:-]+)([^>]*)>/g, (_, tag, attrs) => {
    const normalizedTag = tag.toLowerCase();
    const attrString = attrs ? sanitizeAttributes(attrs, whitelist) : "";
    return `<${normalizedTag}${attrString}>`;
  });
};

const reduceSegments = (
  segments: ContextSegment[],
  whitelist: Set<string>,
): { segments: ContextSegment[]; touchedSegmentIds: string[] } => {
  const touched: string[] = [];
  const next = segments.map((segment) => {
    if (!isHtmlSegment(segment.text)) return segment;
    const trimmed = segment.text;
    const sanitized = sanitizeHtml(trimmed, whitelist);
    if (sanitized === trimmed) return segment;
    touched.push(segment.id);
    return { ...segment, text: sanitized };
  });
  return { segments: next, touchedSegmentIds: touched };
};

export const htmlSlimmingPass: ReductionPassHandler = {
  beforeCall({ turnCtx, spec }) {
    const options = resolveOptions(spec.options);
    if (!options.enabled) {
      return {
        changed: false,
        skippedReason: "disabled",
      };
    }

    const whitelist = new Set<string>(options.attributeWhitelist ?? DEFAULT_ATTRIBUTES);
    const { segments: nextSegments, touchedSegmentIds } = reduceSegments(turnCtx.segments, whitelist);
    if (touchedSegmentIds.length === 0) {
      return { changed: false, skippedReason: "no_html_segments" };
    }

    return {
      changed: true,
      turnCtx: { ...turnCtx, segments: nextSegments },
      note: "html_slimming",
      touchedSegmentIds,
    };
  },
};
