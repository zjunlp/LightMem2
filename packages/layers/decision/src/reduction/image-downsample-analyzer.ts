import type { ContextSegment } from "@tokenpilot/kernel";
import type { ReductionDecision, ReductionInstruction } from "../types.js";

// ============================================================================
// Types
// ============================================================================

type ImageDownsampleInfo = {
  index: number;
  segmentId: string;
  imageFormat: string;
  originalSize: number;
  estimatedSavings: number;
};

// ============================================================================
// Utilities
// ============================================================================

const BASE64_REGEX =
  /data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,([A-Za-z0-9+/=]+)/g;

const SVG_DATA_REGEX =
  /data:image\/svg\+xml;utf8,(<svg[\s\S]*?<\/svg>)/g;

/**
 * Calculate approximate byte size of base64 string
 * Base64 encodes 3 bytes as 4 characters, so decoded size ≈ (encoded * 3) / 4
 */
function getBase64DecodedSize(base64Data: string): number {
  const base64Only = base64Data.split(",")[1] || base64Data;
  const padding = (base64Only.match(/=+$/) || [""])[0].length;
  const effectiveLength = base64Only.length - padding;
  return Math.floor((effectiveLength * 3) / 4);
}

/**
 * Find base64 images in content and return their sizes
 */
function findBase64Images(
  content: string,
): { format: string; data: string; size: number; startIndex: number }[] {
  const results: { format: string; data: string; size: number; startIndex: number }[] = [];

  BASE64_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = BASE64_REGEX.exec(content)) !== null) {
    const format = match[1];
    const data = match[0];
    const size = getBase64DecodedSize(data);

    results.push({
      format,
      data,
      size,
      startIndex: match.index,
    });
  }

  return results;
}

/**
 * Find inline SVG in content
 */
function findInlineSvg(content: string): { data: string; size: number; startIndex: number }[] {
  const results: { data: string; size: number; startIndex: number }[] = [];

  SVG_DATA_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = SVG_DATA_REGEX.exec(content)) !== null) {
    const data = match[0];
    results.push({
      data,
      size: data.length,
      startIndex: match.index,
    });
  }

  return results;
}

/**
 * Generate a placeholder for downsampled image
 */
export function createImagePlaceholder(
  format: string,
  originalSize: number,
  reason: string,
): string {
  const sizeKB = Math.round(originalSize / 1024);
  return `[${format.toUpperCase()} image: ${sizeKB}KB - ${reason}]`;
}

/**
 * Generate a placeholder for downsampled SVG
 */
export function createSvgPlaceholder(
  originalSize: number,
  reason: string,
): string {
  const sizeKB = Math.round(originalSize / 1024);
  return `[SVG image: ${sizeKB}KB - ${reason}]`;
}

// ============================================================================
// Image Downsample Analyzer
// ============================================================================

export type ImageDownsampleAnalyzerConfig = {
  enabled?: boolean;
  minSegmentChars?: number;
  maxImageSizeKB?: number;
  maxSvgSizeKB?: number;
  minSavedChars?: number;
};

const DEFAULT_CONFIG: Required<ImageDownsampleAnalyzerConfig> = {
  enabled: true,
  minSegmentChars: 500,
  maxImageSizeKB: 100, // 100KB threshold for base64 images
  maxSvgSizeKB: 50, // 50KB threshold for inline SVG
  minSavedChars: 1000,
};

/**
 * Analyze context for segments with large base64 images that need downsampling.
 *
 * Image downsampling strategy:
 * - Detect base64-encoded images (PNG, JPEG, GIF, WebP, SVG)
 * - Replace images exceeding size threshold with placeholder text
 * - Preserve image metadata (format, approximate size)
 */
export function analyzeImageDownsample(
  segments: ContextSegment[],
  config: ImageDownsampleAnalyzerConfig = DEFAULT_CONFIG,
): ReductionDecision {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enabled) {
    return {
      enabled: false,
      instructions: [],
      estimatedSavedChars: 0,
      notes: ["image_downsample_analyzer_disabled"],
    };
  }

  const downsampleCandidates: ImageDownsampleInfo[] = [];

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (segment.text.length < cfg.minSegmentChars) continue;

    const base64Images = findBase64Images(segment.text);
    const svgImages = findInlineSvg(segment.text);

    const oversizedImages = base64Images.filter(
      (img) => img.size / 1024 > cfg.maxImageSizeKB,
    );
    const oversizedSvgs = svgImages.filter(
      (svg) => svg.size / 1024 > cfg.maxSvgSizeKB,
    );

    if (oversizedImages.length === 0 && oversizedSvgs.length === 0) continue;

    const totalSavings =
      oversizedImages.reduce((sum, img) => sum + img.data.length, 0) +
      oversizedSvgs.reduce((sum, svg) => sum + svg.data.length, 0);

    if (totalSavings < cfg.minSavedChars) continue;

    // Report the largest image for the rationale
    const allOversized = [
      ...oversizedImages.map((img) => ({ format: img.format, size: img.size })),
      ...oversizedSvgs.map((svg) => ({ format: "svg", size: svg.size })),
    ];
    const largestImage = allOversized.reduce(
      (max, curr) => (curr.size > max.size ? curr : max),
      allOversized[0],
    );

    downsampleCandidates.push({
      index: i,
      segmentId: segment.id,
      imageFormat: largestImage.format,
      originalSize: largestImage.size,
      estimatedSavings: totalSavings,
    });
  }

  const instructions: ReductionInstruction[] = [];
  let estimatedSavedChars = 0;

  for (const candidate of downsampleCandidates) {
    instructions.push({
      strategy: "image_downsample",
      segmentIds: [candidate.segmentId],
      confidence: 0.80,
      priority: 2,
      rationale: `Large ${candidate.imageFormat.toUpperCase()} image detected (${Math.round(candidate.originalSize / 1024)}KB), exceeds threshold, estimated savings: ${candidate.estimatedSavings} chars`,
      parameters: {
        maxImageSizeKB: cfg.maxImageSizeKB,
        maxSvgSizeKB: cfg.maxSvgSizeKB,
        estimatedSavings: candidate.estimatedSavings,
      },
    });

    estimatedSavedChars += candidate.estimatedSavings;
  }

  return {
    enabled: true,
    instructions,
    estimatedSavedChars,
    notes: [
      `analyzed_segments=${segments.length}`,
      `downsample_candidates=${downsampleCandidates.length}`,
      `estimated_saved_chars=${estimatedSavedChars}`,
    ],
  };
}
