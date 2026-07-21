/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ContextSegment } from "@tokenpilot/kernel";
import {
  buildReadWindowKey,
  detectToolPayloadKind,
  extractPathLike,
  isContextSafePersistedInputItem,
  isLikelyToolLikeInputItem,
  parseFunctionCallArgsMapFromInput,
  type BuildLayeredReductionContextDeps,
} from "./reduction-context-shared.js";
import type { ProxyReductionBinding } from "./reduction-context-types.js";

export function scanReductionInput(params: {
  input: any[];
  deps: BuildLayeredReductionContextDeps;
  memoryFaultRecoverToolName: string;
  hasRecoveryMarker: (details: unknown) => boolean;
  segmentAnchorByCallId?: Map<string, { turnAbsIds: string[]; taskIds: string[] }>;
  orderedTurnAnchors?: Array<{ turnAbsId: string; taskIds: string[] }>;
  onReducibleText: (segmentId: string, text: string, toolName: string) => void;
  onReadSegment: (
    toolName: string,
    dataPath: string,
    readKey: string,
    segmentId: string,
    fieldName?: string,
  ) => void;
}): {
  segments: ContextSegment[];
  bindings: ProxyReductionBinding[];
  toolLikeItems: number;
  persistedSkippedItems: number;
} {
  const {
    input,
    deps,
    memoryFaultRecoverToolName,
    hasRecoveryMarker,
    segmentAnchorByCallId,
    orderedTurnAnchors,
    onReducibleText,
    onReadSegment,
  } = params;
  const callArgsMap = parseFunctionCallArgsMapFromInput(input);
  const segments: ContextSegment[] = [];
  const bindings: ProxyReductionBinding[] = [];
  let toolLikeItems = 0;
  let persistedSkippedItems = 0;
  let orderedTurnIndex = -1;
  let currentOrderedAnchor: { turnAbsIds: string[]; taskIds: string[] } | undefined;

  const addSegment = (
    segmentId: string,
    text: string,
    metadata: Record<string, unknown>,
    binding: ProxyReductionBinding,
  ): void => {
    segments.push({
      id: segmentId,
      kind: "volatile",
      text,
      priority: 100,
      source: "proxy.input",
      metadata,
    });
    bindings.push(binding);
  };

  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (!item || typeof item !== "object") continue;
    if (String(item.role ?? "").toLowerCase() === "user" && orderedTurnAnchors) {
      const nextAnchor = orderedTurnAnchors[orderedTurnIndex + 1];
      if (nextAnchor) {
        orderedTurnIndex += 1;
        currentOrderedAnchor = {
          turnAbsIds: [nextAnchor.turnAbsId],
          taskIds: nextAnchor.taskIds,
        };
      }
    }
    if (!isLikelyToolLikeInputItem(item)) continue;
    if (isContextSafePersistedInputItem(item)) {
      persistedSkippedItems += 1;
      continue;
    }
    toolLikeItems += 1;

    const itemType = String(item.type ?? "").toLowerCase();
    const itemRole = String(item.role ?? "").toLowerCase();
    const callId = String(item.call_id ?? item.tool_call_id ?? item.id ?? "").trim();
    const callMeta = callId ? callArgsMap.get(callId) : undefined;
    const anchored = (callId ? segmentAnchorByCallId?.get(callId) : undefined) ?? currentOrderedAnchor;
    const toolName = String(
      item.name
      ?? item.tool_name
      ?? item.toolName
      ?? callMeta?.toolName
      ?? "",
    ).trim();
    const isMemoryFaultRecoveryTool =
      toolName.toLowerCase() === memoryFaultRecoverToolName
      || hasRecoveryMarker(item?.details);
    const directPath =
      extractPathLike(item)
      ?? extractPathLike(item?.details)
      ?? (() => {
        try {
          const args = typeof item.arguments === "string" ? JSON.parse(item.arguments) : item.arguments;
          return extractPathLike(args);
        } catch {
          return undefined;
        }
      })();
    const dataPath = String(callMeta?.path ?? directPath ?? "").trim();
    const readWindow = callMeta?.readWindow;
    const readKey = dataPath ? buildReadWindowKey(dataPath, readWindow) : "";

    const buildMetadata = (
      text: string,
      fieldName: "arguments" | "output" | "result" | "content",
      extra?: Record<string, unknown>,
    ): Record<string, unknown> => ({
      toolName,
      path: dataPath,
      turnAbsIds: anchored?.turnAbsIds,
      taskIds: anchored?.taskIds,
      itemType,
      itemRole,
      fieldName,
      recovery: isMemoryFaultRecoveryTool
        ? {
          source: memoryFaultRecoverToolName,
          skipReduction: true,
        }
        : undefined,
      toolPayload: {
        toolName,
        path: dataPath,
        readWindow,
        turnAbsIds: anchored?.turnAbsIds,
        taskIds: anchored?.taskIds,
        payloadKind: detectToolPayloadKind(text, deps) ?? "stdout",
      },
      ...extra,
    });

    const pushFieldBinding = (
      fieldName: "arguments" | "output" | "result",
      applyReduction: boolean,
    ): void => {
      const text = item[fieldName];
      if (typeof text !== "string" || text.length === 0) return;
      const segmentId = `proxy-${index}-${fieldName}`;
      addSegment(
        segmentId,
        text,
        buildMetadata(text, fieldName),
        { segmentId, itemIndex: index, field: fieldName, beforeLen: text.length, toolName, dataPath },
      );
      if (applyReduction && !isMemoryFaultRecoveryTool) {
        onReducibleText(segmentId, text, toolName);
      }
      onReadSegment(toolName, dataPath, readKey, segmentId, fieldName);
    };

    pushFieldBinding("arguments", false);
    pushFieldBinding("output", true);
    pushFieldBinding("result", true);

    if (typeof item.content === "string" && item.content.length > 0) {
      const segmentId = `proxy-${index}-content`;
      addSegment(
        segmentId,
        item.content,
        buildMetadata(item.content, "content"),
        { segmentId, itemIndex: index, field: "content", beforeLen: item.content.length, toolName, dataPath },
      );
      if (!isMemoryFaultRecoveryTool) {
        onReducibleText(segmentId, item.content, toolName);
      }
      onReadSegment(toolName, dataPath, readKey, segmentId);
    }

    if (Array.isArray(item.content)) {
      item.content.forEach((block: any, blockIndex: number) => {
        if (!block || typeof block !== "object") return;
        const blockKey: "text" | "content" | undefined =
          typeof block.text === "string"
            ? "text"
            : typeof block.content === "string"
              ? "content"
              : undefined;
        if (!blockKey) return;
        const text = String(block[blockKey] ?? "");
        if (!text) return;
        const segmentId = `proxy-${index}-content-${blockIndex}-${blockKey}`;
        addSegment(
          segmentId,
          text,
          buildMetadata(text, "content", { blockIndex, blockKey }),
          {
            segmentId,
            itemIndex: index,
            field: "content",
            blockIndex,
            blockKey,
            beforeLen: text.length,
            toolName,
            dataPath,
          },
        );
        if (!isMemoryFaultRecoveryTool) {
          onReducibleText(segmentId, text, toolName);
        }
        onReadSegment(toolName, dataPath, readKey, segmentId);
      });
    }
  }

  return {
    segments,
    bindings,
    toolLikeItems,
    persistedSkippedItems,
  };
}
