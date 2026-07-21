/* eslint-disable @typescript-eslint/no-explicit-any */
import { Transform } from "node:stream";
export { isSseContentType } from "./upstream-sse-shared.js";
import {
  buildResponsesCompletedPayload,
  finalizeChatCompletionsResponsesSse,
} from "./upstream-sse-events.js";
import { processChatCompletionsSseBlock } from "./upstream-sse-process.js";
import { createChatCompletionsSseState, findSseBoundary, isSseContentType } from "./upstream-sse-shared.js";

export function createChatCompletionsToResponsesSseTransform(): Transform {
  let buffer = "";
  const state = createChatCompletionsSseState();
  return new Transform({
    transform(chunk, _encoding, callback) {
      buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      let boundary = findSseBoundary(buffer);
      while (boundary) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.separatorLength);
        const converted = processChatCompletionsSseBlock(block, state);
        if (converted) this.push(converted);
        boundary = findSseBoundary(buffer);
      }
      callback();
    },
    flush(callback) {
      const converted = buffer.trim() ? processChatCompletionsSseBlock(buffer, state) : "";
      if (converted) this.push(converted);
      const final = finalizeChatCompletionsResponsesSse(state);
      if (final) this.push(final);
      callback();
    },
  });
}

export function convertChatCompletionsSseToResponsesSse(rawSse: string): string {
  const blocks = String(rawSse ?? "").split(/\r?\n\r?\n/u);
  const state = createChatCompletionsSseState();
  const out: string[] = [];
  for (const block of blocks) {
    const converted = processChatCompletionsSseBlock(block, state);
    if (converted) out.push(converted);
  }
  const final = finalizeChatCompletionsResponsesSse(state);
  if (final) out.push(final);
  return out.join("");
}

export function convertChatCompletionsSseToResponsesText(rawSse: string): string {
  const blocks = String(rawSse ?? "").split(/\r?\n\r?\n/u);
  const state = createChatCompletionsSseState();
  for (const block of blocks) {
    processChatCompletionsSseBlock(block, state);
  }
  return JSON.stringify(buildResponsesCompletedPayload(state));
}
