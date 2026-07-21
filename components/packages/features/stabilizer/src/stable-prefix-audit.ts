import type { SerializedStablePrefixContract } from "./stable-prefix-contract.js";
import { canonicalizeTools } from "./tools.js";

export type StablePrefixEntropyKind =
  | "timestamp"
  | "uuid"
  | "abs_path"
  | "long_number"
  | "tooling_order_risk";

export type StablePrefixEntropyFinding = {
  kind: StablePrefixEntropyKind;
  segmentKey: string;
  layer: "stable_core" | "semi_stable_context";
  detail: string;
};

export type StablePrefixDriftReason = {
  kind:
    | "segment_added"
    | "segment_removed"
    | "segment_text_changed"
    | "segment_role_changed"
    | "segment_source_changed";
  key: string;
  detail: string;
};

type SerializedSegment = SerializedStablePrefixContract["stableCore"][number];

function collectSegments(
  serialized: SerializedStablePrefixContract,
): Array<SerializedSegment & { layer: "stable_core" | "semi_stable_context" }> {
  return [
    ...serialized.stableCore.map((segment) => ({ ...segment, layer: "stable_core" as const })),
    ...serialized.semiStableContext.map((segment) => ({ ...segment, layer: "semi_stable_context" as const })),
  ];
}

export function auditStablePrefixEntropy(
  serialized: SerializedStablePrefixContract,
): StablePrefixEntropyFinding[] {
  const findings: StablePrefixEntropyFinding[] = [];
  for (const segment of collectSegments(serialized)) {
    const text = String(segment.text ?? "");
    if (/\b\d{4}-\d{2}-\d{2}[T ][0-9:.+\-Z]{6,}\b/.test(text)) {
      findings.push({
        kind: "timestamp",
        segmentKey: segment.key,
        layer: segment.layer,
        detail: "timestamp-like value detected in stable prefix",
      });
    }
    if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i.test(text)) {
      findings.push({
        kind: "uuid",
        segmentKey: segment.key,
        layer: segment.layer,
        detail: "UUID-like value detected in stable prefix",
      });
    }
    if (/(?:^|[\s:(])(?:[A-Za-z]:[\\/]|\/)[^\s)\]}]+/.test(text) && !text.includes("<WORKDIR>")) {
      findings.push({
        kind: "abs_path",
        segmentKey: segment.key,
        layer: segment.layer,
        detail: "absolute path detected without placeholder normalization",
      });
    }
    if (/\b\d{10,}\b/.test(text)) {
      findings.push({
        kind: "long_number",
        segmentKey: segment.key,
        layer: segment.layer,
        detail: "long numeric identifier detected in stable prefix",
      });
    }
    if (segment.key === "tools") {
      try {
        const parsed = JSON.parse(text);
        const canonicalText = JSON.stringify(canonicalizeTools(Array.isArray(parsed) ? parsed : [parsed]));
        if (canonicalText !== text) {
          findings.push({
            kind: "tooling_order_risk",
            segmentKey: segment.key,
            layer: segment.layer,
            detail: "tool order or nested tool object keys are not yet canonicalized",
          });
        }
      } catch {
        // ignore non-JSON tool segments
      }
    }
  }
  return findings;
}

function indexSegments(
  serialized: SerializedStablePrefixContract,
): Map<string, SerializedSegment & { layer: "stable_core" | "semi_stable_context" }> {
  return new Map(
    collectSegments(serialized).map((segment) => [segment.key, segment]),
  );
}

export function diffStablePrefixSerialized(
  previous: SerializedStablePrefixContract | null | undefined,
  current: SerializedStablePrefixContract,
): StablePrefixDriftReason[] {
  if (!previous) return [];
  const reasons: StablePrefixDriftReason[] = [];
  const prevMap = indexSegments(previous);
  const currMap = indexSegments(current);
  const keys = new Set([...prevMap.keys(), ...currMap.keys()]);

  for (const key of keys) {
    const prev = prevMap.get(key);
    const curr = currMap.get(key);
    if (!prev && curr) {
      reasons.push({
        kind: "segment_added",
        key,
        detail: `stable segment added to ${curr.layer}`,
      });
      continue;
    }
    if (prev && !curr) {
      reasons.push({
        kind: "segment_removed",
        key,
        detail: `stable segment removed from ${prev.layer}`,
      });
      continue;
    }
    if (!prev || !curr) continue;
    if ((prev.role ?? "") !== (curr.role ?? "")) {
      reasons.push({
        kind: "segment_role_changed",
        key,
        detail: `role changed from ${prev.role ?? "(none)"} to ${curr.role ?? "(none)"}`,
      });
    }
    if (prev.source !== curr.source) {
      reasons.push({
        kind: "segment_source_changed",
        key,
        detail: `source changed from ${prev.source} to ${curr.source}`,
      });
    }
    if (prev.text !== curr.text) {
      reasons.push({
        kind: "segment_text_changed",
        key,
        detail: "stable segment text changed",
      });
    }
  }

  return reasons;
}
