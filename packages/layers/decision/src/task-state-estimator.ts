import type {
  SemanticTaskUpdate,
  TaskStateEstimator,
  TaskStateEstimatorApiConfig,
  TaskStateEstimatorInput,
  TaskStateEstimatorOutput,
} from "./types.js";

function truncateText(value: string, maxChars = 600): string {
  const text = value.trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...`;
}

function uniqueStrings(values: Iterable<string>): string[] {
  return [...new Set([...values].filter((value) => value.trim().length > 0))];
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function buildSystemPrompt(
  config: Required<Pick<TaskStateEstimatorApiConfig, "evictionLookaheadTurns" | "lifecycleMode">>,
): string {
  const coupled = config.lifecycleMode === "coupled";
  return [
    "You are a task-state estimator for a long-running agent session.",
    "Your job is to update global task state incrementally.",
    "You must only return a JSON object.",
    "Do not output a full registry.",
    "You must return only a semantic delta, not a registry patch.",
    "The input is incremental, but the task registry is global.",
    "Each update may modify the lifecycle of any existing task in the session, including older tasks that are not directly covered by the newest delta.",
    "You must backfill task ownership for every covered turn in the delta window.",
    "Never invent turn ids that are not present in the provided delta.",
    "When the newest covered turn contains a new top-level user request, you must decide whether it starts a new task.",
    "If the newest user request is materially different from the objective of the current active task, create a new task update anchored to the first covered turn of that new request instead of extending the old task.",
    "If a newer top-level user request starts a different task, do not keep an older unrelated one-shot task active.",
    ...(coupled
      ? [
          "When an older task already has delivery evidence, no unresolved questions, and is not covered by the current delta, you may mark it evictable instead of leaving it active.",
          "When the hints include evictableCandidateTaskIds and the newest covered turn clearly starts or finishes a different task, you should usually emit lifecycle-only updates that mark those candidate tasks evictable in the same response.",
          "Do not wait for another future turn to mark an obviously finished older task evictable once a newer distinct task has already taken over the session.",
          "Never mark a task evictable unless it is already completed or you are simultaneously providing clear completionEvidence.",
          "Never use evictable for a task that still lacks completion evidence, still has unresolved questions, or is obviously in progress.",
          "Use completed only when the task is finished but still likely to be referenced again immediately. Use evictable only when the task is finished, has completionEvidence, has no unresolved questions, and the session has already moved on to a different task.",
        ]
      : [
          "Your job is only task progression classification, not cache replacement.",
          "Only decide whether each task is active, blocked, or completed.",
          "Do not decide eviction timing.",
          "Never output lifecycle=evictable; eviction will be decided separately by the system.",
          "Use completed when a task is finished and has delivery evidence, even if it may later be evicted by a separate policy layer.",
        ]),
    "Prefer one task per distinct user request unless the new request is clearly just a continuation or clarification of the same objective.",
    "For a newly created task, use a stable taskId derived from the first covered turn, typically `<firstTurnAbsId>` or `<firstTurnAbsId>-task`.",
    "Output schema must be exactly:",
    "{\"baseVersion\": number, \"taskUpdates\": SemanticTaskUpdate[]}.",
    "SemanticTaskUpdate must use exactly these fields:",
    coupled
      ? "{\"taskId\": string, \"title\"?: string, \"objective\": string, \"lifecycle\": \"active\"|\"blocked\"|\"completed\"|\"evictable\", \"coveredTurnAbsIds\"?: string[], \"completionEvidence\"?: string[], \"unresolvedQuestions\"?: string[], \"currentSubgoal\"?: string, \"evictableReason\"?: string}."
      : "{\"taskId\": string, \"title\"?: string, \"objective\": string, \"lifecycle\": \"active\"|\"blocked\"|\"completed\", \"coveredTurnAbsIds\"?: string[], \"completionEvidence\"?: string[], \"unresolvedQuestions\"?: string[], \"currentSubgoal\"?: string}.",
    "coveredTurnAbsIds is required when creating a new task or extending task ownership to new turns.",
    "coveredTurnAbsIds may be omitted or empty for lifecycle-only updates on existing tasks.",
    "If lifecycle is completed or evictable, include completionEvidence unless the existing registry entry already has strong completion evidence.",
    ...(coupled ? ["If lifecycle is evictable, include evictableReason as one short sentence."] : []),
    "Do not output registry patch fields such as upsertTasks, activeTaskIds, completedTaskIds, evictableTaskIds, upsertTurnToTaskIds, transitions, span, or lastProcessedTurnSeq.",
    "Do not use alternate field names such as status, description, action, fromTurnSeq, toTurnSeq, task_created, or task_progressed.",
    "The delta may include completedTaskSummaries when older completed tasks have been compressed out of the active estimator context.",
    "Treat completedTaskSummaries as stable background memory and prefer keeping the currently unresolved task as one continuous task unless the newest user request clearly starts a new objective.",
  ].join(" ");
}

function buildDerivedHints(input: TaskStateEstimatorInput): Record<string, unknown> {
  const coveredTurnAbsIds = uniqueStrings(input.delta.coveredTurnAbsIds ?? []);
  const coveredTurnSet = new Set(coveredTurnAbsIds);
  const deltaUserMessages = input.delta.messages.filter((message) => message.role === "user");
  const newestUserMessage = deltaUserMessages.at(-1);
  const newestUserTurnAbsId = newestUserMessage?.anchor.turnAbsId;
  const newestUserTurnSeq = newestUserMessage?.anchor.turnSeq;
  const previousActiveTaskIds = uniqueStrings(input.registry.activeTaskIds ?? []);

  const taskHints = Object.values(input.registry.tasks).map((task) => {
    const supportingTurnAbsIds = uniqueStrings(task.span?.supportingTurnAbsIds ?? []);
    const coveredByDelta = supportingTurnAbsIds.filter((turnAbsId) => coveredTurnSet.has(turnAbsId));
    const lastTaskTurnAbsId = task.span?.lastTurnAbsId;
    const lastTaskTurnSeq = typeof lastTaskTurnAbsId === "string"
      ? Number(lastTaskTurnAbsId.split(":t").at(-1) ?? Number.NaN)
      : Number.NaN;
    const turnsSinceLastTaskTurn = Number.isFinite(lastTaskTurnSeq) && typeof newestUserTurnSeq === "number"
      ? Math.max(0, newestUserTurnSeq - lastTaskTurnSeq)
      : undefined;
    const unresolvedQuestions = Array.isArray(task.unresolvedQuestions) ? task.unresolvedQuestions : [];
    const completionEvidence = Array.isArray(task.completionEvidence) ? task.completionEvidence : [];
    const objective = task.objective ?? "";
    const title = task.title ?? "";
    const artifactLikeObjective =
      /\b(write|create|draft|summarize|summary|report|email|triage|plan|analysis|stock|pdf|spreadsheet|sheet|document)\b/i
        .test(`${title}\n${objective}`);
    return {
      taskId: task.taskId,
      lifecycle: task.lifecycle,
      title,
      objective: truncateText(objective, 240),
      isCoveredInDelta: coveredByDelta.length > 0,
      coveredTurnAbsIdsInDelta: coveredByDelta,
      lastTurnAbsId: lastTaskTurnAbsId,
      turnsSinceLastTaskTurn,
      completionEvidenceCount: completionEvidence.length,
      hasCompletionEvidence: completionEvidence.length > 0,
      unresolvedQuestionCount: unresolvedQuestions.length,
      hasUnresolvedQuestions: unresolvedQuestions.length > 0,
      artifactLikeObjective,
      wasPreviouslyActive: previousActiveTaskIds.includes(task.taskId),
    };
  });
  const evictableCandidateTaskIds = taskHints
    .filter((task) =>
      task.lifecycle === "completed"
      && !task.isCoveredInDelta
      && task.hasCompletionEvidence
      && !task.hasUnresolvedQuestions
      && typeof task.turnsSinceLastTaskTurn === "number"
      && task.turnsSinceLastTaskTurn >= 1
    )
    .map((task) => task.taskId);

  return {
    deltaInputMode: input.delta.inputMode ?? "sliding_window",
    newestCoveredUserTurnAbsId: newestUserTurnAbsId,
    newestCoveredUserText: newestUserMessage ? truncateText(newestUserMessage.text, 400) : undefined,
    deltaMessageCount: input.delta.messages.length,
    deltaToolCallCount: input.delta.toolCalls.length,
    deltaToolResultCount: input.delta.toolResults.length,
    completedTaskSummaryCount: Array.isArray(input.delta.completedTaskSummaries)
      ? input.delta.completedTaskSummaries.length
      : 0,
    coveredTurnAbsIds,
    previousActiveTaskIds,
    evictableCandidateTaskIds,
    existingTaskHints: taskHints,
  };
}

function buildUserPayload(input: TaskStateEstimatorInput): string {
  return JSON.stringify({
    registry: input.registry,
    delta: input.delta,
    hints: buildDerivedHints(input),
  });
}

function extractTextFromResponsePayload(payload: any): string {
  const output = Array.isArray(payload?.output) ? payload.output : [];
  const texts: string[] = [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (typeof part?.text === "string" && part.text.trim()) {
        texts.push(part.text.trim());
      }
    }
  }
  if (texts.length > 0) return texts.join("\n");
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }
  return "";
}

function extractTextFromChatCompletionPayload(payload: any): string {
  const choices = Array.isArray(payload?.choices) ? payload.choices : [];
  const first = choices[0];
  const content = first?.message?.content;
  if (typeof content === "string" && content.trim()) {
    return content.trim();
  }
  if (Array.isArray(content)) {
    const texts = content
      .map((part: any) => (typeof part?.text === "string" ? part.text.trim() : ""))
      .filter((text: string) => text.length > 0);
    if (texts.length > 0) return texts.join("\n");
  }
  return "";
}

function normalizeTaskUpdate(update: SemanticTaskUpdate): SemanticTaskUpdate {
  return {
    taskId: String(update.taskId ?? "").trim(),
    ...(typeof update.title === "string" && update.title.trim()
      ? { title: update.title.trim() }
      : {}),
    objective: String(update.objective ?? "").trim(),
    lifecycle: update.lifecycle,
    ...(Array.isArray(update.coveredTurnAbsIds)
      ? {
          coveredTurnAbsIds: update.coveredTurnAbsIds
            .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
            .map((value) => value.trim()),
        }
      : {}),
    ...(Array.isArray(update.completionEvidence)
      ? {
          completionEvidence: update.completionEvidence
            .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
            .map((value) => value.trim()),
        }
      : {}),
    ...(Array.isArray(update.unresolvedQuestions)
      ? {
          unresolvedQuestions: update.unresolvedQuestions
            .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
            .map((value) => value.trim()),
        }
      : {}),
    ...(typeof update.currentSubgoal === "string" && update.currentSubgoal.trim()
      ? { currentSubgoal: update.currentSubgoal.trim() }
      : {}),
    ...(typeof update.evictableReason === "string" && update.evictableReason.trim()
      ? { evictableReason: update.evictableReason.trim() }
      : {}),
  };
}

function normalizeEstimatorOutput(
  parsed: TaskStateEstimatorOutput,
  input: TaskStateEstimatorInput,
): TaskStateEstimatorOutput {
  const taskUpdates = Array.isArray(parsed.taskUpdates)
    ? parsed.taskUpdates.map((update) => normalizeTaskUpdate(update))
    : [];
  return {
    baseVersion: input.registry.version,
    taskUpdates,
  };
}

function parseEstimatorOutput(
  rawText: string,
  input: TaskStateEstimatorInput,
): TaskStateEstimatorOutput {
  const trimmed = rawText.trim();
  if (!trimmed) {
    throw new Error("task-state estimator returned empty response");
  }
  const parsed = JSON.parse(trimmed) as TaskStateEstimatorOutput;
  if (typeof parsed?.baseVersion !== "number") {
    throw new Error("task-state estimator output missing baseVersion");
  }
  if (!Array.isArray(parsed.taskUpdates)) {
    throw new Error("task-state estimator output missing taskUpdates");
  }
  return normalizeEstimatorOutput(parsed, input);
}

export function createApiTaskStateEstimator(
  cfg: TaskStateEstimatorApiConfig,
): TaskStateEstimator {
  if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) {
    throw new Error("task-state estimator requires baseUrl, apiKey, and model");
  }
  const baseUrl = normalizeBaseUrl(cfg.baseUrl);
  const requestTimeoutMs = Math.max(1000, cfg.requestTimeoutMs ?? 60_000);
  const evictionLookaheadTurns = Math.max(1, cfg.evictionLookaheadTurns ?? 3);
  const lifecycleMode = cfg.lifecycleMode === "decoupled" ? "decoupled" : "coupled";

  async function requestViaResponses(
    controller: AbortController,
    input: TaskStateEstimatorInput,
  ): Promise<TaskStateEstimatorOutput> {
    const response = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: cfg.model,
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: buildSystemPrompt({ evictionLookaheadTurns, lifecycleMode }) }],
          },
          {
            role: "user",
            content: [{ type: "input_text", text: buildUserPayload(input) }],
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
    const rawText = extractTextFromResponsePayload(payload);
    return parseEstimatorOutput(rawText, input);
  }

  async function requestViaChatCompletions(
    controller: AbortController,
    input: TaskStateEstimatorInput,
  ): Promise<TaskStateEstimatorOutput> {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          {
            role: "system",
            content: buildSystemPrompt({ evictionLookaheadTurns, lifecycleMode }),
          },
          {
            role: "user",
            content: buildUserPayload(input),
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
    const rawText = extractTextFromChatCompletionPayload(payload);
    return parseEstimatorOutput(rawText, input);
  }

  return {
    async estimate(input: TaskStateEstimatorInput): Promise<TaskStateEstimatorOutput> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        try {
          return await requestViaResponses(controller, input);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (
            !message.includes("responses_api_failed:")
            || (!message.includes("convert_request_failed") && !message.includes("not implemented"))
          ) {
            throw error;
          }
        }
        return await requestViaChatCompletions(controller, input);
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
