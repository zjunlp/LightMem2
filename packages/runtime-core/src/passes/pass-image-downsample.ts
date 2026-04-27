import type { ReductionPassHandler } from "../reduction/types.js";
import { createImagePlaceholder, createSvgPlaceholder } from "@tokenpilot/decision";

type AsObject<T> = T extends Record<string, unknown> ? T : Record<string, unknown>;

const asObject = <T>(value: unknown): AsObject<T> | undefined => {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as AsObject<T>)
    : undefined;
};

const BASE64_REGEX =
  /data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,([A-Za-z0-9+/=]+)/g;

const SVG_DATA_REGEX =
  /data:image\/svg\+xml;utf8,(<svg[\s\S]*?<\/svg>)/g;

const applyImageDownsample = (
  content: string,
  maxImageSizeKB: number,
  maxSvgSizeKB: number,
): { content: string; changed: boolean; downsampledCount: number; savedChars: number } => {
  let result = content;
  let downsampledCount = 0;
  let savedChars = 0;

  // Process base64 images
  BASE64_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  const base64ImagesToReplace: { fullMatch: string; format: string; size: number }[] = [];

  while ((match = BASE64_REGEX.exec(content)) !== null) {
    const format = match[1];
    const fullMatch = match[0];
    const base64Data = match[2] || "";
    // Approximate decoded size: (base64_length * 3) / 4
    const decodedSize = Math.floor((base64Data.length * 3) / 4);
    const sizeKB = decodedSize / 1024;

    if (sizeKB > maxImageSizeKB) {
      base64ImagesToReplace.push({
        fullMatch,
        format,
        size: decodedSize,
      });
    }
  }

  // Replace oversized base64 images
  for (const img of base64ImagesToReplace) {
    const placeholder = createImagePlaceholder(img.format, img.size, "downsampled for context reduction");
    result = result.replace(img.fullMatch, placeholder);
    savedChars += img.fullMatch.length - placeholder.length;
    downsampledCount++;
  }

  // Process inline SVG
  SVG_DATA_REGEX.lastIndex = 0;
  const svgImagesToReplace: { fullMatch: string; size: number }[] = [];

  while ((match = SVG_DATA_REGEX.exec(content)) !== null) {
    const fullMatch = match[0];
    const sizeKB = fullMatch.length / 1024;

    if (sizeKB > maxSvgSizeKB) {
      svgImagesToReplace.push({
        fullMatch,
        size: fullMatch.length,
      });
    }
  }

  // Replace oversized SVG images
  for (const svg of svgImagesToReplace) {
    const placeholder = createSvgPlaceholder(svg.size, "downsampled for context reduction");
    result = result.replace(svg.fullMatch, placeholder);
    savedChars += svg.fullMatch.length - placeholder.length;
    downsampledCount++;
  }

  return {
    content: result,
    changed: result !== content,
    downsampledCount,
    savedChars,
  };
};

export const imageDownsamplePass: ReductionPassHandler = {
  afterCall({ currentResult, spec, turnCtx }) {
    // Check if policy provided instructions for this strategy
    const policy = asObject(turnCtx.metadata?.policy);
    const decisions = asObject(policy?.decisions);
    const reduction = asObject(decisions?.reduction);
    const instructions = Array.isArray(reduction?.instructions)
      ? (reduction.instructions as Array<{ strategy: string; segmentIds: string[]; parameters?: Record<string, unknown> }>)
      : [];

    // Find instructions for image_downsample strategy
    const imageDownsampleInstructions = instructions.filter(
      (instr) => instr.strategy === "image_downsample",
    );

    // If no instructions, skip (policy didn't identify image downsample candidates)
    if (imageDownsampleInstructions.length === 0) {
      return {
        changed: false,
        skippedReason: "no_policy_instructions",
      };
    }

    // Get thresholds from instruction parameters or spec
    const instrParams = imageDownsampleInstructions[0]?.parameters ?? {};
    const maxImageSizeKB =
      (instrParams.maxImageSizeKB as number)
      ?? (typeof spec.options?.maxImageSizeKB === "number" ? spec.options.maxImageSizeKB : undefined)
      ?? 100;
    const maxSvgSizeKB =
      (instrParams.maxSvgSizeKB as number)
      ?? (typeof spec.options?.maxSvgSizeKB === "number" ? spec.options.maxSvgSizeKB : undefined)
      ?? 50;

    const { content, changed, downsampledCount, savedChars } = applyImageDownsample(
      currentResult.content,
      maxImageSizeKB,
      maxSvgSizeKB,
    );

    if (!changed) {
      return {
        changed: false,
        skippedReason: "no_images_to_downsample",
      };
    }

    return {
      changed: true,
      note: `image_downsample:${downsampledCount} images replaced with placeholders`,
      result: {
        ...currentResult,
        content,
      },
      metadata: {
        imageDownsample: {
          originalSize: currentResult.content.length,
          reducedSize: content.length,
          savedChars,
          downsampledCount,
          maxImageSizeKB,
          maxSvgSizeKB,
        },
      },
    };
  },
};
