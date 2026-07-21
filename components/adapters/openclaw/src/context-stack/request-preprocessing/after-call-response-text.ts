/* eslint-disable @typescript-eslint/no-explicit-any */
export function extractProxyResponseText(parsedResponse: any): string {
  if (!parsedResponse || typeof parsedResponse !== "object") return "";
  if (typeof parsedResponse.output_text === "string" && parsedResponse.output_text.trim().length > 0) {
    return parsedResponse.output_text;
  }
  const response = parsedResponse?.response;
  if (response && typeof response === "object") {
    return extractProxyResponseText(response);
  }
  const output = Array.isArray(parsedResponse?.output) ? parsedResponse.output : [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const type = String(item.type ?? "").toLowerCase();
    if (type === "output_text" && typeof item.text === "string" && item.text.trim().length > 0) {
      return item.text;
    }
    if (type === "message" && Array.isArray(item.content)) {
      for (const block of item.content) {
        if (!block || typeof block !== "object") continue;
        if (String(block.type ?? "").toLowerCase() !== "output_text") continue;
        if (typeof block.text === "string" && block.text.trim().length > 0) {
          return block.text;
        }
      }
    }
  }
  return "";
}

export function patchProxyResponseText(parsedResponse: any, nextText: string): boolean {
  if (!parsedResponse || typeof parsedResponse !== "object") return false;
  let changed = false;

  if (typeof parsedResponse.output_text === "string" && parsedResponse.output_text !== nextText) {
    parsedResponse.output_text = nextText;
    changed = true;
  }

  const output = Array.isArray(parsedResponse.output) ? parsedResponse.output : [];
  let replacedNested = false;
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const type = String(item.type ?? "").toLowerCase();
    if (type === "output_text" && typeof item.text === "string") {
      if (item.text !== nextText) {
        item.text = nextText;
        changed = true;
      }
      replacedNested = true;
      break;
    }
    if (type === "message" && Array.isArray(item.content)) {
      for (const block of item.content) {
        if (!block || typeof block !== "object") continue;
        if (String(block.type ?? "").toLowerCase() !== "output_text") continue;
        if (typeof block.text !== "string") continue;
        if (block.text !== nextText) {
          block.text = nextText;
          changed = true;
        }
        replacedNested = true;
        break;
      }
      if (replacedNested) break;
    }
  }

  return changed;
}

export function isSseContentType(contentType: string | null | undefined): boolean {
  return String(contentType ?? "").toLowerCase().includes("text/event-stream");
}
