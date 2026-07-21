import type { ReductionPassHandler } from "../reduction/types.js";

type AsObject<T> = T extends Record<string, unknown> ? T : Record<string, unknown>;

const asObject = <T>(value: unknown): AsObject<T> | undefined => {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as AsObject<T>)
    : undefined;
};

/**
 * Modified Session Startup section that tells agent files are already provided
 */
const MODIFIED_SESSION_STARTUP = `## Session Startup

The following files are **already in your context** — do NOT read them with the read tool:

- \`SOUL.md\` — your identity (already injected)
- \`USER.md\` — who you're helping (already injected)

If memory files exist in this workspace, they will be listed below in the **Memory** section — you do NOT need to read them manually, they are already provided.

`;

/**
 * Pattern to match the Session Startup section in an injected agent instruction file.
 * Matches from "## Session Startup" to the next "##" header or end of section.
 */
const SESSION_STARTUP_PATTERN = /## Session Startup\s*\n(?:.*?\n)*?(?=\n##\s|##$|$)/i;

/**
 * Check if content contains the problematic Session Startup section.
 */
function hasSessionStartupSection(content: string): boolean {
  return SESSION_STARTUP_PATTERN.test(content);
}

/**
 * Replace Session Startup section with modified version.
 */
function replaceSessionStartup(content: string): { content: string; changed: boolean } {
  const match = content.match(SESSION_STARTUP_PATTERN);
  if (!match) {
    return { content, changed: false };
  }

  const newContent = content.replace(SESSION_STARTUP_PATTERN, MODIFIED_SESSION_STARTUP.trim() + '\n');
  return { content: newContent, changed: newContent !== content };
}

/**
 * Also modify the Memory section to clarify on-demand reading.
 */
const MODIFIED_MEMORY_SECTION = `## Memory

**Do NOT read memory files with the read tool.**

If memory files exist, their content will appear in your context automatically:

- **Daily notes:** \`memory/YYYY-MM-DD.md\` — raw logs (injected if exists)
- **Long-term:** \`MEMORY.md\` — curated memories (injected if exists)

Check the workspace file list to see if these files exist. If you don't see memory/ directory or MEMORY.md in the file list, they don't exist in this workspace — that's normal, just work with what you have.

`;

const MEMORY_SECTION_PATTERN = /## Memory\s*\n(?:.*?\n)*?(?=##\s|##$|$)/s;

const AGENT_FILE_HEADER_PATTERNS = [
  /\[AGENTS\.md\]/i,
  /# AGENTS\.md\b/i,
  /## .*\/AGENTS\.md\b/i,
  /\[AGENT(?:\s|_|-)INSTRUCTIONS?\]/i,
];

function looksLikeAgentInstructionSegment(content: string): boolean {
  return AGENT_FILE_HEADER_PATTERNS.some((pattern) => pattern.test(content));
}

function replaceMemorySection(content: string): { content: string; changed: boolean } {
  const match = content.match(MEMORY_SECTION_PATTERN);
  if (!match) {
    return { content, changed: false };
  }

  const newContent = content.replace(MEMORY_SECTION_PATTERN, MODIFIED_MEMORY_SECTION.trim() + '\n');
  return { content: newContent, changed: newContent !== content };
}

export const agentsStartupOptimizationPass: ReductionPassHandler = {
  beforeCall({ turnCtx, spec }) {
    // Check if enabled
    const options = spec.options ?? {};
    const enabled = options.enabled !== false; // Default enabled

    if (!enabled) {
      return {
        changed: false,
        skippedReason: "disabled",
      };
    }

    let modifiedSegmentCount = 0;
    let totalSavedChars = 0;
    const modifiedSegmentIds: string[] = [];
    let segmentCheckedCount = 0;
    let agentsSegmentFound = false;

    // Find segments that contain an injected agent instruction file.
    for (let i = 0; i < turnCtx.segments.length; i += 1) {
      const segment = turnCtx.segments[i];
      const text = segment.text;
      segmentCheckedCount++;

      // Hosts can surface agent instructions in slightly different wrappers.
      const isAgentsSegment =
        looksLikeAgentInstructionSegment(text) &&
        text.includes("## Session Startup");

      if (isAgentsSegment) {
        agentsSegmentFound = true;
      }

      if (!isAgentsSegment) continue;

      // Apply transformations
      let newContent = text;
      let segmentChanged = false;

      // Replace Session Startup section
      const startupResult = replaceSessionStartup(newContent);
      if (startupResult.changed) {
        newContent = startupResult.content;
        segmentChanged = true;
      }

      // Replace Memory section
      const memoryResult = replaceMemorySection(newContent);
      if (memoryResult.changed) {
        newContent = memoryResult.content;
        segmentChanged = true;
      }

      if (segmentChanged) {
        const savedChars = text.length - newContent.length;
        totalSavedChars += savedChars;
        modifiedSegmentCount++;
        modifiedSegmentIds.push(segment.id);

        turnCtx.segments[i] = {
          ...segment,
          text: newContent,
        };
      }
    }

    if (modifiedSegmentCount === 0) {
      return {
        changed: false,
        skippedReason: "no_agents_md_segments_found",
        note: `agents_startup_optimization: checked ${segmentCheckedCount} segments, agentsSegmentFound=${agentsSegmentFound}`,
        metadata: {
          agentsStartupOptimization: {
            segmentCheckedCount,
            agentsSegmentFound,
            modifiedSegmentCount,
          },
        },
      };
    }

    return {
      changed: true,
      note: `agents_startup_optimization: modified ${modifiedSegmentCount} segments, prevented redundant read instructions (~${totalSavedChars} chars)`,
      touchedSegmentIds: modifiedSegmentIds,
      metadata: {
        agentsStartupOptimization: {
          segmentCheckedCount,
          agentsSegmentFound,
          modifiedSegmentCount,
          totalSavedChars,
          modifiedSegmentIds,
          preventedReads: ["SOUL.md", "USER.md", "MEMORY.md", "memory/YYYY-MM-DD.md"],
        },
      },
    };
  },
};
