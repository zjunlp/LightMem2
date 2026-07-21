import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBaseSessionOverview,
  buildSessionResponseChain,
  resolveBaseSessionTopology,
} from "../src/session-topology.js";

test("buildSessionResponseChain preserves unique response order", () => {
  const chain = buildSessionResponseChain(
    [
      { responseId: "resp-2" },
      { responseId: "resp-2" },
      { responseId: "resp-1" },
      { responseId: "" },
    ],
    (binding) => binding.responseId,
  );

  assert.deepEqual(chain, ["resp-2", "resp-1"]);
});

test("resolveBaseSessionTopology merges snapshot and binding fields consistently", () => {
  const topology = resolveBaseSessionTopology({
    sessionId: "sess-1",
    snapshot: {
      latestResponseId: "resp-2",
      previousResponseId: "resp-1",
      latestModel: "gpt-5.4",
      workspaceHint: "/tmp/work",
      updatedAt: "2026-07-03T00:00:00.000Z",
      extraFlag: "ok",
    },
    bindings: [
      {
        responseId: "resp-2",
        previousResponseId: "resp-1",
        model: "fallback-model",
        updatedAt: "2026-07-02T00:00:00.000Z",
      },
      {
        responseId: "resp-1",
        previousResponseId: null,
        model: "fallback-model",
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
    ],
    getSnapshotLatestResponseId: (value) => value?.latestResponseId,
    getBindingResponseId: (value) => value?.responseId,
    getSnapshotPreviousResponseId: (value) => value?.previousResponseId,
    getBindingPreviousResponseId: (value) => value?.previousResponseId,
    getSnapshotModel: (value) => value?.latestModel,
    getBindingModel: (value) => value?.model,
    getSnapshotWorkspaceHint: (value) => value?.workspaceHint,
    getSnapshotUpdatedAt: (value) => value?.updatedAt,
    getBindingUpdatedAt: (value) => value?.updatedAt,
    buildExtra: (value) => ({
      extraFlag: value?.extraFlag,
    }),
  });

  assert.equal(topology.sessionId, "sess-1");
  assert.equal(topology.latestResponseId, "resp-2");
  assert.equal(topology.previousResponseId, "resp-1");
  assert.equal(topology.latestModel, "gpt-5.4");
  assert.equal(topology.workspaceHint, "/tmp/work");
  assert.equal(topology.updatedAt, "2026-07-03T00:00:00.000Z");
  assert.equal(topology.turnCount, 2);
  assert.deepEqual(topology.responseChain, ["resp-2", "resp-1"]);
  assert.equal(topology.extraFlag, "ok");
});

test("buildBaseSessionOverview renders shared overview rows and response chain", () => {
  const overview = buildBaseSessionOverview({
    sessionId: "sess-2",
    turnCount: 3,
    latestModel: "claude-test",
    workspaceHint: "/repo",
    latestResponseId: "msg-3",
    previousResponseId: "msg-2",
    responseChain: ["msg-3", "msg-2", "msg-1"],
  }, [
    { label: "Latest request chars", value: 480 },
  ]);

  assert.deepEqual(overview, [
    { label: "Session", value: "sess-2" },
    { label: "Turns", value: 3 },
    { label: "Model", value: "claude-test" },
    { label: "Workspace", value: "/repo" },
    { label: "Latest response", value: "msg-3" },
    { label: "Previous response", value: "msg-2" },
    { label: "Latest request chars", value: 480 },
    { label: "Response chain", value: "msg-3 -> msg-2 -> msg-1" },
  ]);
});
