/* eslint-disable @typescript-eslint/no-explicit-any */

export function extractItemText(item: any, extractInputText: (input: any) => string): string {
  if (!item || typeof item !== "object") return "";
  return extractInputText([item]).trim();
}

function stringifyStructuredValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function normalizeResponsesInputForUpstream(input: any): void {
  if (!Array.isArray(input)) return;
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const type = String((item as any).type ?? "").toLowerCase();
    if (type === "function_call" && typeof (item as any).arguments !== "string") {
      (item as any).arguments = stringifyStructuredValue((item as any).arguments);
      continue;
    }
    if (type === "function_call_output" && typeof (item as any).output !== "string") {
      (item as any).output = stringifyStructuredValue((item as any).output);
    }
  }
}

export function findLastUserItem(input: any): { userIndex: number; userItem: any | null } | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  for (let i = input.length - 1; i >= 0; i -= 1) {
    const item = input[i];
    if (!item || typeof item !== "object") continue;
    if (String((item as any).role) === "user") {
      return { userIndex: i, userItem: item };
    }
  }
  return null;
}

function extractResponseFunctionCalls(parsed: any): Array<{
  id: string;
  call_id: string;
  name: string;
  arguments: string;
  status?: string;
}> {
  if (!parsed || typeof parsed !== "object") return [];
  const output = Array.isArray(parsed.output) ? parsed.output : [];
  const calls: Array<{
    id: string;
    call_id: string;
    name: string;
    arguments: string;
    status?: string;
  }> = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    if (String(item.type ?? "").toLowerCase() !== "function_call") continue;
    const id = typeof item.id === "string" && item.id ? item.id : `call_${Date.now().toString(36)}_${calls.length}`;
    const callId = typeof item.call_id === "string" && item.call_id ? item.call_id : id;
    const name = typeof item.name === "string" ? item.name : "";
    const args = typeof item.arguments === "string" ? item.arguments : "";
    calls.push({
      id,
      call_id: callId,
      name,
      arguments: args,
      status: typeof item.status === "string" ? item.status : undefined,
    });
  }
  return calls;
}

export function summarizeResponseFunctionCalls(parsed: any): Array<{
  id: string;
  call_id: string;
  name: string;
  argumentsLength: number;
  argumentsPreview: string;
  argumentsJsonParseOk: boolean;
  parsedArgumentKeys: string[];
  parsedPath: string | null;
}> {
  const calls = extractResponseFunctionCalls(parsed);
  return calls.map((call) => {
    let parsedArgs: any = null;
    let argumentsJsonParseOk = false;
    try {
      parsedArgs = JSON.parse(call.arguments);
      argumentsJsonParseOk = true;
    } catch {
      parsedArgs = null;
    }
    const parsedArgumentKeys =
      parsedArgs && typeof parsedArgs === "object" && !Array.isArray(parsedArgs)
        ? Object.keys(parsedArgs).slice(0, 12)
        : [];
    const parsedPath =
      parsedArgs && typeof parsedArgs === "object" && !Array.isArray(parsedArgs)
        ? typeof parsedArgs.path === "string"
          ? parsedArgs.path
          : typeof parsedArgs.file_path === "string"
            ? parsedArgs.file_path
            : null
        : null;
    return {
      id: call.id,
      call_id: call.call_id,
      name: call.name,
      argumentsLength: call.arguments.length,
      argumentsPreview: call.arguments.slice(0, 300),
      argumentsJsonParseOk,
      parsedArgumentKeys,
      parsedPath,
    };
  });
}
