/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  applyBeforeToolCallDefaults,
  applyWorkspacePathHintToToolParams,
  canonicalMessageTaskIds,
  dedupeStrings,
  ensureContextSafeDetails,
  extractToolMessageText,
  extractWorkspaceDirFromMessages,
  isToolResultLikeMessage,
  messageToolCallId,
} from "./runtime-tooling.js";
import {
  contentToText,
  extractItemText,
  extractLastUserMessage,
  extractOpenClawSessionId,
  extractProviderResponseText,
  extractResponseTextFromProviderNode,
  extractSessionKey,
  findLastUserItem,
} from "./runtime-event-text.js";

type PluginLoggerLike = {
  info?: (...args: any[]) => void;
  debug?: (...args: any[]) => void;
  warn?: (...args: any[]) => void;
  error?: (...args: any[]) => void;
};

export function makeLogger(input?: PluginLoggerLike): Required<PluginLoggerLike> {
  return {
    info: input?.info ?? ((...args) => console.log(...args)),
    debug: input?.debug ?? (() => {}),
    warn: input?.warn ?? ((...args) => console.warn(...args)),
    error: input?.error ?? ((...args) => console.error(...args)),
  };
}

export function hookOn(api: any, event: string, handler: (...args: any[]) => any): void {
  if (typeof api.on === "function") {
    api.on(event, handler);
    return;
  }
  if (typeof api.registerHook === "function") {
    api.registerHook(event, handler);
  }
}

export function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export {
  applyBeforeToolCallDefaults,
  applyWorkspacePathHintToToolParams,
  canonicalMessageTaskIds,
  contentToText,
  dedupeStrings,
  ensureContextSafeDetails,
  extractItemText,
  extractLastUserMessage,
  extractOpenClawSessionId,
  extractProviderResponseText,
  extractResponseTextFromProviderNode,
  extractSessionKey,
  extractToolMessageText,
  extractWorkspaceDirFromMessages,
  findLastUserItem,
  isToolResultLikeMessage,
  messageToolCallId,
};
