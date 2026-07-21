/* eslint-disable @typescript-eslint/no-explicit-any */
export type ChatCompletionsSseState = {
  responseId: string;
  model: string;
  accumulatedText: string;
  usage: any;
  completed: boolean;
  started: boolean;
  textItemAdded: boolean;
  textItemDone: boolean;
  toolCallsByIndex: Map<number, {
    id: string;
    callId: string;
    name: string;
    arguments: string;
    added: boolean;
    done: boolean;
  }>;
};

export function isSseContentType(contentType: string | null | undefined): boolean {
  return String(contentType ?? "").toLowerCase().includes("text/event-stream");
}

export function createChatCompletionsSseState(): ChatCompletionsSseState {
  return {
    responseId: "",
    model: "",
    accumulatedText: "",
    usage: null,
    completed: false,
    started: false,
    textItemAdded: false,
    textItemDone: false,
    toolCallsByIndex: new Map(),
  };
}

export function formatSseEvent(event: any): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function findSseBoundary(buffer: string): { index: number; separatorLength: number } | null {
  const rn = buffer.indexOf("\r\n\r\n");
  const nn = buffer.indexOf("\n\n");
  if (rn < 0 && nn < 0) return null;
  if (rn >= 0 && (nn < 0 || rn <= nn)) {
    return { index: rn, separatorLength: 4 };
  }
  return { index: nn, separatorLength: 2 };
}
