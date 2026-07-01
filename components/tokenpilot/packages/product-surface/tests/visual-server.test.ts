import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildStabilityVisualSnapshotFromTexts,
  buildVisualRequestId,
  writeReductionVisualSegments,
  writeStabilityVisualSnapshot,
  readVisualSessionData,
  readVisualSessionList,
  startMultiHostVisualServer,
  type ReductionVisualSnapshot,
} from "../src/index.js";

test("visual bridge helpers persist shared stability and reduction snapshots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tokenpilot-visual-bridge-"));
  try {
    const stateDir = join(dir, "codex");
    const requestId = buildVisualRequestId(["bridge", "session-1", 1]);
    await writeStabilityVisualSnapshot({
      stateDir,
      snapshot: {
        kind: "stability",
        at: "2026-06-29T12:00:00.000Z",
        sessionId: "session-1",
        model: "gpt-5.4-mini",
        upstreamModel: "gpt-5.4-mini",
        promptCacheKeyBefore: "",
        promptCacheKeyAfter: "pk-1",
        dynamicContextTarget: "user",
        userContentRewrites: 1,
        senderMetadataBlocksBefore: 0,
        senderMetadataBlocksAfter: 0,
        developerBefore: "Your working directory is: /repo/demo",
        developerCanonical: "Your working directory is: <WORKDIR>",
        developerForwarded: "Your working directory is: <WORKDIR>",
        dynamicContextText: "- WORKDIR: /repo/demo",
        firstTurnCandidate: true,
      },
    });
    await writeReductionVisualSegments({
      stateDir,
      at: "2026-06-29T12:00:01.000Z",
      sessionId: "session-1",
      requestId,
      model: "gpt-5.4-mini",
      upstreamModel: "gpt-5.4-mini",
      segments: [
        {
          segmentId: "seg-1",
          itemIndex: 0,
          field: "content",
          savedChars: 123,
          beforeText: "before",
          afterText: "after",
          report: [],
        },
      ],
    });

    const sessions = await readVisualSessionList(stateDir);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.sessionId, "session-1");
    assert.equal(sessions[0]?.stabilityCount, 1);
    assert.equal(sessions[0]?.reductionCount, 1);

    const data = await readVisualSessionData(stateDir, "session-1");
    assert.equal(data.stability[0]?.promptCacheKeyAfter, "pk-1");
    assert.equal(data.reduction[0]?.requestId, requestId);
    assert.equal(data.reduction[0]?.savedChars, 123);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stability bridge builder derives canonical prompt and user rewrite count from shared text inputs", () => {
  const snapshot = buildStabilityVisualSnapshotFromTexts({
    at: "2026-06-29T13:00:00.000Z",
    sessionId: "session-2",
    model: "gpt-5.4-mini",
    upstreamModel: "gpt-5.4-mini",
    promptCacheKeyBefore: "",
    promptCacheKeyAfter: "pk-2",
    dynamicContextTarget: "user",
    developerBefore: "Your working directory is: /repo/demo\nRuntime: agent=agent-1 |\nBe precise.",
    developerForwarded: "Your working directory is: <WORKDIR>\nRuntime: agent=<AGENT_ID> |\nBe precise.",
    userBefore: "hello",
    userForwarded: "- WORKDIR: /repo/demo\n- AGENT_ID: agent-1\n\nhello",
    firstTurnCandidate: true,
  });

  assert.match(snapshot.developerCanonical, /<WORKDIR>/);
  assert.match(snapshot.dynamicContextText ?? "", /WORKDIR: \/repo\/demo/);
  assert.equal(snapshot.userContentRewrites, 1);
});

test("multi-host visual server exposes hosts and host-scoped sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tokenpilot-multi-host-visual-"));
  try {
    const openclawStateDir = join(dir, "openclaw");
    const codexStateDir = join(dir, "codex");
    await mkdir(join(openclawStateDir, "tokenpilot", "visual", "reduction"), { recursive: true });
    await mkdir(join(codexStateDir, "tokenpilot", "visual", "reduction"), { recursive: true });

    const openclawSnapshot: ReductionVisualSnapshot = {
      kind: "reduction",
      at: "2026-06-29T10:00:00.000Z",
      sessionId: "openclaw-session-1",
      requestId: "req-openclaw-1",
      model: "gpt-5.4-mini",
      upstreamModel: "gpt-5.4-mini",
      segmentId: "seg-openclaw-1",
      itemIndex: 0,
      field: "content",
      savedChars: 111,
      beforeText: "before-openclaw",
      afterText: "after-openclaw",
      report: [],
    };
    const codexSnapshot: ReductionVisualSnapshot = {
      kind: "reduction",
      at: "2026-06-29T11:00:00.000Z",
      sessionId: "codex-session-1",
      requestId: "req-codex-1",
      model: "gpt-5.4-mini",
      upstreamModel: "gpt-5.4-mini",
      segmentId: "seg-codex-1",
      itemIndex: 0,
      field: "content",
      savedChars: 222,
      beforeText: "before-codex",
      afterText: "after-codex",
      report: [],
    };

    await writeFile(
      join(openclawStateDir, "tokenpilot", "visual", "reduction", "openclaw-session-1.jsonl"),
      `${JSON.stringify(openclawSnapshot)}\n`,
      "utf8",
    );
    await writeFile(
      join(codexStateDir, "tokenpilot", "visual", "reduction", "codex-session-1.jsonl"),
      `${JSON.stringify(codexSnapshot)}\n`,
      "utf8",
    );

    const handle = await startMultiHostVisualServer([
      {
        hostId: "openclaw",
        displayName: "OpenClaw",
        stateDir: openclawStateDir,
      },
      {
        hostId: "codex",
        displayName: "Codex",
        stateDir: codexStateDir,
      },
    ]);

    try {
      const hostsResp = await fetch(`${handle.url}/api/hosts`);
      const hostsPayload = await hostsResp.json() as {
        hosts: Array<{
          hostId: string;
          displayName: string;
          sessionCount: number;
          stabilityCount: number;
          reductionCount: number;
          evictionCount: number;
          latestAt: string;
        }>;
      };
      assert.deepEqual(
        hostsPayload.hosts.map((host) => [
          host.hostId,
          host.sessionCount,
          host.stabilityCount,
          host.reductionCount,
          host.evictionCount,
        ]),
        [
          ["codex", 1, 0, 1, 0],
          ["openclaw", 1, 0, 1, 0],
        ],
      );
      assert.equal(hostsPayload.hosts[0]?.latestAt, "2026-06-29T11:00:00.000Z");
      assert.equal(hostsPayload.hosts[1]?.latestAt, "2026-06-29T10:00:00.000Z");

      const openclawSessionsResp = await fetch(`${handle.url}/api/sessions?host=openclaw`);
      const openclawSessionsPayload = await openclawSessionsResp.json() as {
        hostId: string;
        sessions: Array<{ sessionId: string }>;
      };
      assert.equal(openclawSessionsPayload.hostId, "openclaw");
      assert.deepEqual(openclawSessionsPayload.sessions.map((session) => session.sessionId), ["openclaw-session-1"]);

      const codexSessionResp = await fetch(
        `${handle.url}/api/session?host=codex&sessionId=${encodeURIComponent("codex-session-1")}`,
      );
      const codexSessionPayload = await codexSessionResp.json() as {
        sessionId: string;
        reduction: Array<{ beforeText: string; afterText: string }>;
      };
      assert.equal(codexSessionPayload.sessionId, "codex-session-1");
      assert.equal(codexSessionPayload.reduction[0]?.beforeText, "before-codex");
    } finally {
      await new Promise<void>((resolve) => handle.server.close(() => resolve()));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
