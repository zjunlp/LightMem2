/* eslint-disable @typescript-eslint/no-explicit-any */

export function extractContentText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((entry) => {
        if (!entry || typeof entry !== "object") return "";
        if (typeof entry.text === "string") return entry.text;
        if (typeof entry.content === "string") return entry.content;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (!content || typeof content !== "object") return "";
  if (typeof content.text === "string") return content.text;
  if (typeof content.content === "string") return content.content;
  return "";
}

export function replaceContentText(content: any, nextText: string): any {
  if (typeof content === "string") return nextText;
  if (Array.isArray(content)) {
    const next = content.map((entry) => (entry && typeof entry === "object" ? { ...entry } : entry));
    for (let i = 0; i < next.length; i += 1) {
      const entry = next[i];
      if (!entry || typeof entry !== "object") continue;
      if (typeof (entry as any).text === "string") {
        (entry as any).text = nextText;
        return next;
      }
      if (typeof (entry as any).content === "string") {
        (entry as any).content = nextText;
        return next;
      }
    }
    next.unshift({ type: "input_text", text: nextText });
    return next;
  }
  if (content && typeof content === "object") {
    if (typeof content.text === "string") return { ...content, text: nextText };
    if (typeof content.content === "string") return { ...content, content: nextText };
  }
  return nextText;
}

export function prependTextToContent(content: any, extraText: string): any {
  const extra = String(extraText ?? "").trim();
  if (!extra) return content;
  if (typeof content === "string") {
    return content.trim().length > 0 ? `${extra}\n\n${content}` : extra;
  }
  if (Array.isArray(content)) {
    const next = content.map((item) => (item && typeof item === "object" ? { ...item } : item));
    for (let i = 0; i < next.length; i += 1) {
      const item = next[i];
      if (!item || typeof item !== "object") continue;
      if (typeof (item as any).text === "string") {
        (item as any).text = (item as any).text.trim().length > 0
          ? `${extra}\n\n${String((item as any).text)}`
          : extra;
        return next;
      }
      if (typeof (item as any).content === "string") {
        (item as any).content = (item as any).content.trim().length > 0
          ? `${extra}\n\n${String((item as any).content)}`
          : extra;
        return next;
      }
    }
    next.unshift({ type: "input_text", text: extra });
    return next;
  }
  return extra;
}
