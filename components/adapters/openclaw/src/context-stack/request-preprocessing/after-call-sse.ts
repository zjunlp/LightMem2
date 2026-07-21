/* eslint-disable @typescript-eslint/no-explicit-any */
import { extractProxyResponseText, patchProxyResponseText } from "./after-call-response-text.js";

export function rewriteSseJsonEvents(
  rawSse: string,
  mutator: (event: any) => boolean,
): { text: string; parsedEvents: number; changedEvents: number } {
  const normalized = String(rawSse ?? "");
  if (!normalized.trim()) return { text: normalized, parsedEvents: 0, changedEvents: 0 };
  const blocks = normalized.split(/\r?\n\r?\n/u);
  let parsedEvents = 0;
  let changedEvents = 0;
  const rewrittenBlocks = blocks.map((block) => {
    const lines = block.split(/\r?\n/u);
    const dataLines = lines.filter((line) => line.startsWith("data:"));
    if (dataLines.length === 0) return block;
    const payloadText = dataLines
      .map((line) => line.slice(5).trim())
      .join("\n")
      .trim();
    if (!payloadText || payloadText === "[DONE]") return block;
    let parsed: any = null;
    try {
      parsed = JSON.parse(payloadText);
      parsedEvents += 1;
    } catch {
      return block;
    }
    if (!mutator(parsed)) return block;
    changedEvents += 1;
    const nonData = lines.filter((line) => !line.startsWith("data:"));
    return [...nonData, `data: ${JSON.stringify(parsed)}`].join("\n");
  });
  const text = rewrittenBlocks.join("\n\n");
  return { text, parsedEvents, changedEvents };
}

export function collectSseOutputText(rawSse: string): string {
  const normalized = String(rawSse ?? "");
  if (!normalized.trim()) return "";
  const blocks = normalized.split(/\r?\n\r?\n/u);
  const doneTexts: string[] = [];
  let deltaText = "";
  for (const block of blocks) {
    const lines = block.split(/\r?\n/u);
    const dataLines = lines.filter((line) => line.startsWith("data:"));
    if (dataLines.length === 0) continue;
    const payloadText = dataLines
      .map((line) => line.slice(5).trim())
      .join("\n")
      .trim();
    if (!payloadText || payloadText === "[DONE]") continue;
    try {
      const event = JSON.parse(payloadText) as any;
      const type = String(event?.type ?? "").toLowerCase();
      if (type === "response.output_text.done" && typeof event?.text === "string" && event.text.trim().length > 0) {
        doneTexts.push(event.text);
        continue;
      }
      if (type === "response.content_part.done") {
        const partType = String(event?.part?.type ?? "").toLowerCase();
        if (partType === "output_text" && typeof event?.part?.text === "string" && event.part.text.trim().length > 0) {
          doneTexts.push(event.part.text);
          continue;
        }
      }
      if (type === "response.output_text.delta" && typeof event?.delta === "string") {
        deltaText += event.delta;
      }
    } catch {
      // ignore malformed fragments
    }
  }
  if (doneTexts.length > 0) return doneTexts.join("\n").trim();
  return deltaText.trim();
}

export function patchSseEventForReducedText(event: any, nextText: string): boolean {
  if (!event || typeof event !== "object") return false;
  const type = String(event.type ?? "").toLowerCase();
  let changed = false;
  if (type === "response.output_text.done" && typeof event.text === "string" && event.text !== nextText) {
    event.text = nextText;
    changed = true;
  }
  if (type === "response.content_part.done" && event.part && typeof event.part === "object") {
    const partType = String(event.part.type ?? "").toLowerCase();
    if (partType === "output_text" && typeof event.part.text === "string" && event.part.text !== nextText) {
      event.part.text = nextText;
      changed = true;
    }
  }
  if (type === "response.output_item.done" && event.item && typeof event.item === "object") {
    changed = patchProxyResponseText(event.item, nextText) || changed;
  }
  if (type === "response.completed" && event.response && typeof event.response === "object") {
    changed = patchProxyResponseText(event.response, nextText) || changed;
  }
  return changed;
}

export function resolveCompletedResponseFromSse(rawSse: string): { completedResponse: any; probeChangedEvents: number } {
  let completedResponse: any = null;
  const probe = rewriteSseJsonEvents(rawSse, (event) => {
    if (!event || typeof event !== "object") return false;
    const type = String(event.type ?? "").toLowerCase();
    if (type !== "response.completed" || !event.response || typeof event.response !== "object") return false;
    completedResponse = event.response;
    return false;
  });
  return {
    completedResponse,
    probeChangedEvents: probe.changedEvents,
  };
}

export function ensureCompletedResponseTextFromSse(rawSse: string, completedResponse: any): void {
  const reconstructedText = collectSseOutputText(rawSse);
  if (!extractProxyResponseText(completedResponse) && reconstructedText) {
    if (typeof completedResponse.output_text === "string" || completedResponse.output_text === undefined) {
      completedResponse.output_text = reconstructedText;
    }
  }
}
