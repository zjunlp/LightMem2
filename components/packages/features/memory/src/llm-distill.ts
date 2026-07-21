import { readFile } from "node:fs/promises";
import { makeFallbackSkill } from "./store.js";
import type { DistillProviderConfig, ProceduralMemoryQueueEntry, ProceduralSkill } from "./types.js";

type DistillResponse = {
  skills?: Array<{
    sourceTaskId?: string;
    objective?: string;
    workflow?: string[];
    facts?: string[];
    tool_patterns?: string[];
    pitfalls?: string[];
  }>;
};

type DistillSkillPayload = NonNullable<DistillResponse["skills"]>[number];

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function extractTextFromResponsePayload(payload: any): string {
  const output = Array.isArray(payload?.output) ? payload.output : [];
  const texts: string[] = [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (typeof part?.text === "string" && part.text.trim()) texts.push(part.text.trim());
    }
  }
  if (texts.length > 0) return texts.join("\n");
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) return payload.output_text.trim();
  return "";
}

function extractTextFromChatCompletionPayload(payload: any): string {
  const choices = Array.isArray(payload?.choices) ? payload.choices : [];
  const first = choices[0];
  const content = first?.message?.content;
  if (typeof content === "string" && content.trim()) return content.trim();
  if (Array.isArray(content)) {
    const texts = content
      .map((part: any) => (typeof part?.text === "string" ? part.text.trim() : ""))
      .filter((text: string) => text.length > 0);
    if (texts.length > 0) return texts.join("\n");
  }
  return "";
}

function buildSystemPrompt(): string {
  return [
    "You are a procedural memory extractor for a continual agent system.",
    "You will be given the complete interaction history of recently completed agent tasks, including user instructions, agent reasoning, tool calls, and observations.",
    "Your job is to distill each task history into a compact, reusable procedural memory entry that can help the agent solve structurally similar tasks in the future.",
    "Return only JSON.",
    "You must return exactly one memory entry per input task.",
    "For each task, use exactly this schema:",
    "{\"sourceTaskId\":string,\"objective\":string,\"workflow\":string[],\"facts\":string[],\"tool_patterns\":string[],\"pitfalls\":string[]}",
    "Guidelines:",
    "Objective must describe the task goal, not temporary environment state or private secrets.",
    "Do not erase transcript-grounded anchors that are essential for correctness.",
    "Use facts for the most useful concrete anchors, such as selected decisions, named owners, deadlines, quotes, tone markers, disambiguating entities, or source-specific constraints.",
    "facts should contain 2 to 6 short transcript-grounded bullets that would improve correctness on a structurally similar follow-on task in the same session.",
    "facts must stay faithful to the archived task and should not invent or generalize beyond what the transcript clearly supported.",
    "Preserve the task's true structural domain. Do not broaden a narrow task into a generic modality-level task unless the trajectory clearly supports that broader abstraction.",
    "For example, do not rewrite a restaurant contact lookup into a generic document extraction task, and do not rewrite a finance lookup into a generic OCR task unless OCR itself is the reusable core procedure.",
    "Workflow must include only non-obvious or task-specific actions or decisions that were actually used or clearly justified by the trajectory. Skip generic reasoning boilerplate. Keep 2 to 4 steps when possible. Order matters.",
    "Prefer durable task-level procedure and decision logic over incidental one-off interface mistakes.",
    "Tool patterns must include only meaningfully used tools, with concise notes on when and how to use them effectively for this task.",
    "Only include tool or API validation quirks if they materially affected execution and led to a real correction or retry pattern.",
    "Do not let one-off parameter names, literal field values, exact cron times, or exact request shapes dominate the memory unless that detail is clearly the reusable core of the task.",
    "When possible, express tool guidance at the operation level (for example list, inspect, update, notify) rather than at the literal argument-name level.",
    "Do not recommend hypothetical fallback tools, external searches, or recovery paths that were not actually executed or directly evidenced in the trajectory.",
    "Pitfalls must include only observed failure modes, corrections, or mistakes directly evidenced by the trajectory.",
    "Prefer pitfalls that reflect reusable task risks or decision errors over one-off syntax or schema slips.",
    "For operational tasks, prefer durable failure patterns such as incomplete inventory, unsafe partial remediation, or unresolved root causes over single-call validation quirks.",
    "Do not add generic domain caveats or speculative risks unless the transcript actually showed them.",
    "If no concrete pitfall was observed, return an empty array rather than inventing pitfalls.",
    "Do not preserve user-private details, temporary file paths, access tokens, or stale environment-specific state.",
    "Be concise. Keep each memory entry compact and focused on useful factual anchors plus only the minimum reusable procedure needed to apply them.",
    "Wrap all entries under top-level schema: {\"skills\": [...]}",
  ].join(" ");
}

async function buildUserPayload(entries: ProceduralMemoryQueueEntry[]): Promise<string> {
  const tasks = await Promise.all(
    entries.map(async (entry) => ({
      taskId: entry.taskId,
      objective: entry.objective,
      completionEvidence: entry.completionEvidence,
      unresolvedQuestions: entry.unresolvedQuestions,
      transcriptExcerpt: (await readFile(entry.archivePath, "utf8")).slice(0, 24_000),
    })),
  );
  return JSON.stringify({ tasks });
}

function buildSkillFromResponse(
  entry: ProceduralMemoryQueueEntry,
  raw: DistillSkillPayload | undefined,
): ProceduralSkill {
  const objective = typeof raw?.objective === "string" && raw.objective.trim() ? raw.objective.trim() : entry.objective;
  const workflow = uniqueStrings(raw?.workflow).slice(0, 5);
  const facts = uniqueStrings(raw?.facts).slice(0, 6);
  const toolPatterns = uniqueStrings(raw?.tool_patterns).slice(0, 5);
  const pitfalls = uniqueStrings(raw?.pitfalls).slice(0, 5);
  const guidance = [
    facts.length > 0 ? `Key facts: ${facts.join(" | ")}.` : "",
    workflow.length > 0 ? `Useful procedure: ${workflow.join(" | ")}.` : "",
    toolPatterns.length > 0 ? `Tool patterns: ${toolPatterns.join(" | ")}.` : "",
    pitfalls.length > 0 ? `Pitfalls: ${pitfalls.join(" | ")}.` : "",
  ]
    .filter((item) => item.trim().length > 0)
    .join(" ");
  return makeFallbackSkill(entry.sessionId, entry, {
    title: `Skill for ${entry.taskId}`,
    guidance,
    whenToUse: [objective],
    steps: workflow,
    facts,
    pitfalls,
    constraints: toolPatterns,
  });
}

function parseDistillResponse(text: string, entries: ProceduralMemoryQueueEntry[]): ProceduralSkill[] {
  const parsed = JSON.parse(text) as DistillResponse;
  const skills = Array.isArray(parsed.skills) ? parsed.skills : [];
  const byTaskId = new Map(skills.map((skill) => [String(skill?.sourceTaskId ?? "").trim(), skill] as const));
  return entries.map((entry) => buildSkillFromResponse(entry, byTaskId.get(entry.taskId)));
}

async function requestViaResponses(
  provider: DistillProviderConfig,
  controller: AbortController,
  entries: ProceduralMemoryQueueEntry[],
): Promise<ProceduralSkill[]> {
  const response = await fetch(`${normalizeBaseUrl(provider.baseUrl)}/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${provider.apiKey}`,
    },
    signal: controller.signal,
    body: JSON.stringify({
      model: provider.model,
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: buildSystemPrompt() }],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: await buildUserPayload(entries) }],
        },
      ],
      text: {
        format: {
          type: "json_object",
        },
      },
    }),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`responses_api_failed:${response.status}:${errorText}`);
  }
  const payload = await response.json();
  return parseDistillResponse(extractTextFromResponsePayload(payload), entries);
}

async function requestViaChatCompletions(
  provider: DistillProviderConfig,
  controller: AbortController,
  entries: ProceduralMemoryQueueEntry[],
): Promise<ProceduralSkill[]> {
  const response = await fetch(`${normalizeBaseUrl(provider.baseUrl)}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${provider.apiKey}`,
    },
    signal: controller.signal,
    body: JSON.stringify({
      model: provider.model,
      messages: [
        {
          role: "system",
          content: buildSystemPrompt(),
        },
        {
          role: "user",
          content: await buildUserPayload(entries),
        },
      ],
      response_format: {
        type: "json_object",
      },
      temperature: 0,
    }),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`chat_completions_failed:${response.status}:${errorText}`);
  }
  const payload = await response.json();
  return parseDistillResponse(extractTextFromChatCompletionPayload(payload), entries);
}

export async function distillQueueEntriesWithLlm(params: {
  provider: DistillProviderConfig;
  entries: ProceduralMemoryQueueEntry[];
}): Promise<ProceduralSkill[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, params.provider.requestTimeoutMs ?? 60_000));
  try {
    try {
      return await requestViaResponses(params.provider, controller, params.entries);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        !message.includes("responses_api_failed:")
        || (!message.includes("convert_request_failed") && !message.includes("not implemented"))
      ) {
        throw error;
      }
    }
    return await requestViaChatCompletions(params.provider, controller, params.entries);
  } finally {
    clearTimeout(timeout);
  }
}
