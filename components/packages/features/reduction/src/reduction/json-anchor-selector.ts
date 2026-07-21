export type JsonAnchorPattern =
  | "search_results"
  | "logs"
  | "time_series"
  | "generic";

export type JsonAnchorSelectionOptions = {
  maxItems: number;
  pattern?: JsonAnchorPattern;
  queryText?: string;
  dedupIdenticalItems?: boolean;
  useInformationDensity?: boolean;
  candidateMultiplier?: number;
  anchorBudgetPct?: number;
  minAnchorSlots?: number;
  maxAnchorSlots?: number;
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;
const SEARCH_FIELD_SET = new Set(["title", "url", "content", "score", "snippet"]);
const LOG_FIELD_SET = new Set(["level", "severity", "message", "timestamp", "time"]);
const RECENCY_KEYWORDS = ["latest", "recent", "newest", "last", "current"];
const HISTORICAL_KEYWORDS = ["first", "initial", "original", "earliest", "history"];
const ERROR_KEYWORDS = ["error", "errors", "failure", "fail", "warning", "warn", "exception"];

export function inferJsonAnchorPattern(items: unknown[]): JsonAnchorPattern {
  const dictItems = items.filter(
    (entry) => entry && typeof entry === "object" && !Array.isArray(entry),
  ) as Record<string, unknown>[];
  if (dictItems.length === 0) return "generic";

  let searchLike = 0;
  let logLike = 0;
  let timeSeriesLike = 0;

  for (const item of dictItems) {
    const keys = new Set(Object.keys(item));
    const hasSearchFields = [...SEARCH_FIELD_SET].filter((key) => keys.has(key)).length >= 2;
    const hasLogFields = [...LOG_FIELD_SET].filter((key) => keys.has(key)).length >= 2;
    const hasDateField = Object.values(item).some(
      (value) => typeof value === "string" && ISO_DATE_RE.test(value),
    );
    const hasNumericFields = Object.values(item).filter((value) => typeof value === "number").length >= 1;

    if (hasSearchFields) searchLike += 1;
    if (hasLogFields) logLike += 1;
    if (hasDateField && hasNumericFields) timeSeriesLike += 1;
  }

  const threshold = Math.max(2, Math.ceil(dictItems.length * 0.4));
  if (searchLike >= threshold) return "search_results";
  if (logLike >= threshold) return "logs";
  if (timeSeriesLike >= threshold) return "time_series";
  return "generic";
}

type AnchorWeights = {
  front: number;
  middle: number;
  back: number;
};

const DEFAULT_OPTIONS: Required<JsonAnchorSelectionOptions> = {
  maxItems: 8,
  pattern: "generic",
  queryText: "",
  dedupIdenticalItems: true,
  useInformationDensity: true,
  candidateMultiplier: 3,
  anchorBudgetPct: 1,
  minAnchorSlots: 3,
  maxAnchorSlots: 32,
};

function normalizeWeights(weights: AnchorWeights): AnchorWeights {
  const total = weights.front + weights.middle + weights.back;
  if (total <= 0) return { front: 0.4, middle: 0.2, back: 0.4 };
  return {
    front: weights.front / total,
    middle: weights.middle / total,
    back: weights.back / total,
  };
}

function weightsForPattern(pattern: JsonAnchorPattern): AnchorWeights {
  switch (pattern) {
    case "search_results":
      return normalizeWeights({ front: 0.55, middle: 0.2, back: 0.25 });
    case "logs":
      return normalizeWeights({ front: 0.2, middle: 0.15, back: 0.65 });
    case "time_series":
      return normalizeWeights({ front: 0.45, middle: 0.1, back: 0.45 });
    default:
      return normalizeWeights({ front: 0.35, middle: 0.3, back: 0.35 });
  }
}

function adjustWeightsForQuery(baseWeights: AnchorWeights, queryText: string | undefined): AnchorWeights {
  if (!queryText) return baseWeights;
  const query = queryText.toLowerCase();
  const hasRecency = RECENCY_KEYWORDS.some((keyword) => query.includes(keyword));
  const hasHistorical = HISTORICAL_KEYWORDS.some((keyword) => query.includes(keyword));
  const hasErrorFocus = ERROR_KEYWORDS.some((keyword) => query.includes(keyword));

  let next: AnchorWeights = { ...baseWeights };
  if (hasRecency && !hasHistorical) {
    next = normalizeWeights({
      front: Math.max(0.1, next.front - 0.12),
      middle: next.middle,
      back: Math.min(0.8, next.back + 0.12),
    });
  } else if (hasHistorical && !hasRecency) {
    next = normalizeWeights({
      front: Math.min(0.8, next.front + 0.12),
      middle: next.middle,
      back: Math.max(0.1, next.back - 0.12),
    });
  }

  if (hasErrorFocus) {
    next = normalizeWeights({
      front: Math.max(0.1, next.front - 0.05),
      middle: Math.min(0.45, next.middle + 0.1),
      back: Math.max(0.15, next.back - 0.05),
    });
  }
  return next;
}

function safeJsonText(value: unknown): string {
  try {
    return JSON.stringify(value, Object.keys(value as object).sort());
  } catch {
    return String(value);
  }
}

function safeJsonLength(value: unknown): number {
  return safeJsonText(value).length;
}

function computeItemHash(item: unknown): string {
  return safeJsonText(item);
}

export function calculateJsonInformationScore(item: unknown, allItems: unknown[]): number {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return 0.1;
  }
  const record = item as Record<string, unknown>;
  const dictItems = allItems.filter(
    (entry) => entry && typeof entry === "object" && !Array.isArray(entry),
  ) as Record<string, unknown>[];

  if (dictItems.length <= 1) {
    return Math.min(1, safeJsonLength(item) / 500);
  }

  const fieldValueCounts = new Map<string, Map<string, number>>();
  for (const other of dictItems) {
    for (const [key, value] of Object.entries(other)) {
      const perField = fieldValueCounts.get(key) ?? new Map<string, number>();
      const encoded = safeJsonText(value);
      perField.set(encoded, (perField.get(encoded) ?? 0) + 1);
      fieldValueCounts.set(key, perField);
    }
  }

  let rarityScore = 0;
  let rarityFields = 0;
  for (const [key, value] of Object.entries(record)) {
    const counts = fieldValueCounts.get(key);
    if (!counts) continue;
    const freq = counts.get(safeJsonText(value)) ?? 0;
    rarityScore += 1 - (freq / dictItems.length);
    rarityFields += 1;
  }
  rarityScore = rarityFields > 0 ? rarityScore / rarityFields : 0.5;

  const lengths = dictItems.map((entry) => safeJsonLength(entry));
  const itemLength = safeJsonLength(item);
  const minLength = Math.min(...lengths);
  const maxLength = Math.max(...lengths);
  const lengthScore =
    maxLength > minLength ? (itemLength - minLength) / (maxLength - minLength) : 0.5;

  const fieldCounts = new Map<string, number>();
  for (const other of dictItems) {
    for (const key of Object.keys(other)) {
      fieldCounts.set(key, (fieldCounts.get(key) ?? 0) + 1);
    }
  }
  const commonFields = new Set(
    [...fieldCounts.entries()]
      .filter(([, count]) => count >= dictItems.length * 0.8)
      .map(([key]) => key),
  );
  const rareFields = new Set(
    [...fieldCounts.entries()]
      .filter(([, count]) => count < dictItems.length * 0.2)
      .map(([key]) => key),
  );

  const itemFields = new Set(Object.keys(record));
  let structuralScore = 0;
  if (rareFields.size > 0) {
    structuralScore +=
      0.5 *
      ([...itemFields].filter((key) => rareFields.has(key)).length / rareFields.size);
  }
  if (commonFields.size > 0) {
    structuralScore +=
      0.5 *
      ([...commonFields].filter((key) => !itemFields.has(key)).length / commonFields.size);
  }

  return Math.min(
    1,
    Math.max(0, (rarityScore * 0.4) + (lengthScore * 0.3) + (structuralScore * 0.3)),
  );
}

function shouldInclude(
  items: unknown[],
  index: number,
  seenHashes: Set<string>,
  dedupIdenticalItems: boolean,
  checkOnly = false,
): boolean {
  if (index < 0 || index >= items.length) return false;
  if (!dedupIdenticalItems) return true;
  const item = items[index];
  if (!item || typeof item !== "object" || Array.isArray(item)) return true;
  const hash = computeItemHash(item);
  if (seenHashes.has(hash)) return false;
  if (!checkOnly) seenHashes.add(hash);
  return true;
}

function selectRegionAnchors(
  items: unknown[],
  startIndex: number,
  endIndex: number,
  slotCount: number,
  seenHashes: Set<string>,
  options: Required<JsonAnchorSelectionOptions>,
  useDensity: boolean,
): Set<number> {
  if (slotCount <= 0 || startIndex >= endIndex) return new Set();
  const selected = new Set<number>();
  const regionSize = endIndex - startIndex;

  if (!useDensity) {
    if (slotCount >= regionSize) {
      for (let index = startIndex; index < endIndex; index += 1) {
        if (shouldInclude(items, index, seenHashes, options.dedupIdenticalItems)) {
          selected.add(index);
        }
      }
      return selected;
    }

    const step = regionSize / (slotCount + 1);
    for (let i = 0; i < slotCount; i += 1) {
      const index = Math.min(startIndex + Math.floor((i + 1) * step), endIndex - 1);
      if (shouldInclude(items, index, seenHashes, options.dedupIdenticalItems)) {
        selected.add(index);
        continue;
      }
      for (const offset of [1, -1, 2, -2]) {
        const altIndex = index + offset;
        if (altIndex < startIndex || altIndex >= endIndex) continue;
        if (shouldInclude(items, altIndex, seenHashes, options.dedupIdenticalItems)) {
          selected.add(altIndex);
          break;
        }
      }
    }
    return selected;
  }

  const regionItems = items.slice(startIndex, endIndex);
  const candidates: Array<{ index: number; score: number }> = [];

  for (let index = startIndex; index < endIndex; index += 1) {
    if (!shouldInclude(items, index, seenHashes, options.dedupIdenticalItems, true)) continue;
    candidates.push({
      index,
      score: calculateJsonInformationScore(items[index], regionItems),
    });
  }

  candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, slotCount)
    .forEach((candidate) => {
      if (shouldInclude(items, candidate.index, seenHashes, options.dedupIdenticalItems)) {
        selected.add(candidate.index);
      }
    });

  return selected;
}

export function selectJsonArrayAnchorIndices(
  items: unknown[],
  rawOptions: JsonAnchorSelectionOptions,
): number[] {
  const options: Required<JsonAnchorSelectionOptions> = {
    ...DEFAULT_OPTIONS,
    ...rawOptions,
    pattern: rawOptions.pattern ?? inferJsonAnchorPattern(items),
  };
  const total = items.length;
  if (total === 0) return [];
  if (total <= options.maxItems) {
    return items.map((_item, index) => index);
  }

  const budget = Math.min(
    total,
    Math.max(
      options.minAnchorSlots,
      Math.min(
        options.maxAnchorSlots,
        Math.floor(options.maxItems * options.anchorBudgetPct),
      ),
    ),
  );
  if (budget <= 0) return [];

  const weights = weightsForPattern(options.pattern);
  const adjustedWeights = adjustWeightsForQuery(weights, options.queryText);
  let frontSlots = Math.max(1, Math.floor(budget * adjustedWeights.front));
  let backSlots = Math.max(1, Math.floor(budget * adjustedWeights.back));
  let middleSlots = Math.max(0, budget - frontSlots - backSlots);
  const totalSlots = frontSlots + middleSlots + backSlots;
  if (totalSlots > budget) {
    const overflow = totalSlots - budget;
    const middleReduction = Math.min(middleSlots, overflow);
    middleSlots -= middleReduction;
    const remaining = overflow - middleReduction;
    if (remaining > 0) {
      backSlots = Math.max(1, backSlots - remaining);
    }
  }

  const anchors = new Set<number>();
  const seenHashes = new Set<string>();

  const frontAnchors = selectRegionAnchors(
    items,
    0,
    Math.min(frontSlots * 2, Math.max(1, Math.floor(total / 3))),
    frontSlots,
    seenHashes,
    options,
    false,
  );
  frontAnchors.forEach((index) => anchors.add(index));

  const backStart = Math.max(total - backSlots * 2, Math.floor((2 * total) / 3));
  const backAnchors = selectRegionAnchors(
    items,
    backStart,
    total,
    backSlots,
    seenHashes,
    options,
    false,
  );
  backAnchors.forEach((index) => anchors.add(index));

  if (middleSlots > 0) {
    const middleStart = frontAnchors.size;
    const middleEnd = total - backAnchors.size;
    if (middleEnd > middleStart) {
      const middleAnchors = selectRegionAnchors(
        items,
        middleStart,
        middleEnd,
        middleSlots,
        seenHashes,
        options,
        options.useInformationDensity,
      );
      middleAnchors.forEach((index) => anchors.add(index));
    }
  }

  return [...anchors].sort((a, b) => a - b).slice(0, options.maxItems);
}
