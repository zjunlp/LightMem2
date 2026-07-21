import type { StabilizerRequestEnvelope } from "./contracts.js";
import {
  extractContentText,
  normalizeStablePrefixText,
  rewriteTextForStablePrefix,
} from "./message-text.js";
import { canonicalizeTools } from "./tools.js";
import { createHash } from "node:crypto";

export type StablePrefixLayer = "stable_core" | "semi_stable_context" | "volatile_tail";

export type StablePrefixSegmentSource =
  | "instructions"
  | "message"
  | "tools"
  | "model"
  | "session"
  | "metadata";

export type StablePrefixSegment = {
  layer: StablePrefixLayer;
  source: StablePrefixSegmentSource;
  key: string;
  role?: string;
  text: string;
};

export type StablePrefixContract = {
  stableCore: StablePrefixSegment[];
  semiStableContext: StablePrefixSegment[];
  volatileTail: StablePrefixSegment[];
};

export type SerializedStablePrefixContract = {
  schemaVersion: 1;
  stableCore: Array<Pick<StablePrefixSegment, "key" | "role" | "source" | "text">>;
  semiStableContext: Array<Pick<StablePrefixSegment, "key" | "role" | "source" | "text">>;
};

function pushSegment(
  target: StablePrefixSegment[],
  segment: StablePrefixSegment,
): void {
  if (!segment.text.trim()) return;
  target.push({
    ...segment,
    text: segment.text.trim(),
  });
}

function canonicalizeDynamicContextText(text: string, context?: StablePrefixNormalizationContext): string {
  const raw = String(text ?? "").trim();
  if (!raw) return "";
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      if (/^-?\s*WORKDIR:\s*/i.test(line)) {
        const value = line.replace(/^-?\s*WORKDIR:\s*/i, "").trim();
        const normalized = normalizeStablePrefixText(value, context);
        return `- WORKDIR: ${normalized || "<WORKDIR>"}`;
      }
      if (/^-?\s*AGENT_ID:\s*/i.test(line)) {
        return "- AGENT_ID: <AGENT_ID>";
      }
      return normalizeStablePrefixText(line, context);
    });
  return lines.join("\n");
}

type StablePrefixNormalizationContext = {
  workdir?: string;
  homeDir?: string;
};

function stableStringify(value: unknown, context?: StablePrefixNormalizationContext): string {
  return JSON.stringify(sortJsonValue(value, context));
}

function sortJsonValue(value: unknown, context?: StablePrefixNormalizationContext): unknown {
  if (Array.isArray(value)) return value.map((item) => sortJsonValue(item, context));
  if (!value || typeof value !== "object") return value;
  const objectValue = value as Record<string, unknown>;
  const entries = Object.entries(objectValue)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => {
      const normalizedChild =
        typeof child === "string"
          ? normalizeStablePrefixText(child, context)
          : sortJsonValue(child, context);
      return [key, normalizedChild];
    });
  return Object.fromEntries(entries);
}

export function extractStablePrefixContract(
  envelope: StabilizerRequestEnvelope,
): StablePrefixContract {
  const stableCore: StablePrefixSegment[] = [];
  const semiStableContext: StablePrefixSegment[] = [];
  const volatileTail: StablePrefixSegment[] = [];
  let normalizationContext: StablePrefixNormalizationContext | undefined;

  pushSegment(semiStableContext, {
    layer: "semi_stable_context",
    source: "model",
    key: "model",
    text: envelope.model,
  });

  pushSegment(semiStableContext, {
    layer: "semi_stable_context",
    source: "session",
    key: "session.host",
    text: envelope.session.host.hostId,
  });

  if (typeof envelope.instructions === "string" && envelope.instructions.trim()) {
    const rewrite = rewriteTextForStablePrefix(envelope.instructions);
    normalizationContext = {
      workdir: rewrite.workdir,
    };
    pushSegment(stableCore, {
      layer: "stable_core",
      source: "instructions",
      key: "instructions",
      text: rewrite.canonicalText,
    });
    pushSegment(semiStableContext, {
      layer: "semi_stable_context",
      source: "instructions",
      key: "instructions.dynamic_context",
      text: canonicalizeDynamicContextText(rewrite.dynamicContextText, normalizationContext),
    });
  }

  for (let index = 0; index < envelope.messages.length; index += 1) {
    const message = envelope.messages[index];
    const role = String((message as { role?: string })?.role ?? "");
    const text = extractContentText(message.content);
    if (!text.trim()) continue;

    if (role === "system" || role === "developer") {
      const rewrite = rewriteTextForStablePrefix(text);
      if (!normalizationContext?.workdir && rewrite.workdir) {
        normalizationContext = {
          ...(normalizationContext ?? {}),
          workdir: rewrite.workdir,
        };
      }
      pushSegment(stableCore, {
        layer: "stable_core",
        source: "message",
        key: `messages.${index}`,
        role,
        text: rewrite.canonicalText,
      });
      pushSegment(semiStableContext, {
        layer: "semi_stable_context",
        source: "message",
        key: `messages.${index}.dynamic_context`,
        role,
        text: canonicalizeDynamicContextText(rewrite.dynamicContextText, normalizationContext),
      });
      continue;
    }

    pushSegment(volatileTail, {
      layer: "volatile_tail",
      source: "message",
      key: `messages.${index}`,
      role,
      text,
    });
  }

  if (Array.isArray(envelope.tools) && envelope.tools.length > 0) {
    pushSegment(stableCore, {
      layer: "stable_core",
      source: "tools",
      key: "tools",
      text: stableStringify(canonicalizeTools(envelope.tools), normalizationContext),
    });
  }

  return {
    stableCore,
    semiStableContext,
    volatileTail,
  };
}

export function serializeStablePrefixContract(
  contract: StablePrefixContract,
): SerializedStablePrefixContract {
  const normalize = (segments: StablePrefixSegment[]) => segments.map((segment) => ({
    key: segment.key,
    role: segment.role,
    source: segment.source,
    text: segment.text,
  }));
  return {
    schemaVersion: 1,
    stableCore: normalize(contract.stableCore),
    semiStableContext: normalize(contract.semiStableContext),
  };
}

export function serializeStablePrefixEnvelope(
  envelope: StabilizerRequestEnvelope,
): SerializedStablePrefixContract {
  return serializeStablePrefixContract(extractStablePrefixContract(envelope));
}

export function fingerprintStablePrefixContract(
  contract: StablePrefixContract,
): string {
  return createHash("sha256")
    .update(JSON.stringify(serializeStablePrefixContract(contract)))
    .digest("hex");
}

export function fingerprintStablePrefixEnvelope(
  envelope: StabilizerRequestEnvelope,
): string {
  return fingerprintStablePrefixContract(extractStablePrefixContract(envelope));
}
