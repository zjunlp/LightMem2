import { createCacheModule, createSummaryModule, createCompressionModule } from "@ecoclaw/layer-execution";
import { createTaskRouterModule, createPolicyModule, createDecisionLedgerModule } from "@ecoclaw/layer-decision";
import { createMemoryStateModule } from "@ecoclaw/layer-data";
import { openaiAdapter } from "@ecoclaw/provider-openai";
import { createOpenClawConnector } from "@ecoclaw/layer-orchestration";

async function main() {
  const connector = createOpenClawConnector({
    modules: [
      createCacheModule({ minPrefixChars: 10 }),
      createPolicyModule({ summaryTriggerStableChars: 20 }),
      createTaskRouterModule({
        enabled: true,
        tierRoutes: {
          simple: { provider: "openai", model: "gpt-5-mini" },
          complex: { provider: "openai", model: "gpt-5" },
          reasoning: { provider: "openai", model: "o3" },
        },
      }),
      createDecisionLedgerModule(),
      createMemoryStateModule({ maxSummaryChars: 600 }),
      createSummaryModule({ idleTriggerMinutes: 50 }),
      createCompressionModule({ maxToolChars: 300 }),
    ],
    adapters: { openai: openaiAdapter },
    stateDir: "/tmp/ecoclaw-lab-state",
    routing: {
      autoForkOnPolicy: true,
      physicalSessionPrefix: "phy",
    },
    observability: {
      eventTracePath: "/tmp/ecoclaw-lab-state/ecoclaw/event-trace.jsonl",
    },
  });

  const result = await connector.onLlmCall(
    {
      sessionId: "tui-logical-s1",
      sessionMode: "single",
      provider: "openai",
      model: "gpt-5",
      prompt: "Summarize",
      segments: [
        { id: "a", kind: "stable", text: "system prompt stable block", priority: 1 },
        { id: "b", kind: "volatile", text: "latest user turn", priority: 10 },
      ],
      budget: { maxInputTokens: 8000, reserveOutputTokens: 1000 },
      metadata: {
        logicalSessionId: "tui-logical-s1",
      },
    },
    async () => ({
      content: "x".repeat(500),
      usage: {
        providerRaw: {
          input_tokens: 200,
          output_tokens: 100,
          prompt_tokens_details: { cached_tokens: 128 },
        },
      },
    }),
  );

  const result2 = await connector.onLlmCall(
    {
      sessionId: "tui-logical-s1",
      sessionMode: "single",
      provider: "openai",
      model: "gpt-5",
      prompt: "Continue with concise next steps.",
      segments: [
        { id: "a2", kind: "stable", text: "system prompt stable block", priority: 1 },
        { id: "b2", kind: "volatile", text: "latest user turn", priority: 10 },
      ],
      budget: { maxInputTokens: 8000, reserveOutputTokens: 1000 },
      metadata: {
        logicalSessionId: "tui-logical-s1",
      },
    },
    async () => ({
      content: "y".repeat(300),
      usage: {
        providerRaw: {
          input_tokens: 180,
          output_tokens: 80,
          prompt_tokens_details: { cached_tokens: 96 },
        },
      },
    }),
  );

  await connector.writeSessionSummary("tui-logical-s1", "This is a sample persisted summary.", "bench");

  console.log("Pipeline sample done", result.usage);
  console.log("Second turn usage", result2.usage);
  console.log("Logical->Physical:", connector.getPhysicalSessionId("tui-logical-s1"));
  console.log(
    "Event types:",
    (
      (result.metadata as Record<string, unknown>)?.ecoclawEvents as Array<{ type: string }> | undefined
    )?.map((e) => e.type) ?? [],
  );
  console.log(
    "FinalContext event types:",
    (
      (result.metadata as Record<string, any>)?.ecoclawTrace?.finalContext?.metadata?.ecoclawEvents as
        | Array<{ type: string }>
        | undefined
    )?.map((e) => e.type) ?? [],
  );
  console.log("Summary meta:", (result.metadata as Record<string, unknown>)?.summary);
  console.log(
    "FinalContext cache/policy:",
    (result.metadata as Record<string, any>)?.ecoclawTrace?.finalContext?.metadata?.cache,
    (result.metadata as Record<string, any>)?.ecoclawTrace?.finalContext?.metadata?.policy,
  );
  console.log("State root:", connector.getStateRootDir());
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
