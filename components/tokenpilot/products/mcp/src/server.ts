import { stdin, stdout } from "node:process";
import { handleMcpRequest } from "./index.js";

type HeaderMap = Map<string, string>;

function writeMessage(message: unknown): void {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
  stdout.write(header);
  stdout.write(body);
}

function parseHeaders(raw: string): HeaderMap {
  const headers = new Map<string, string>();
  for (const line of raw.split("\r\n")) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    headers.set(key, value);
  }
  return headers;
}

async function main(): Promise<void> {
  let buffer = Buffer.alloc(0);

  stdin.on("data", async (chunk: Buffer | string) => {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    for (;;) {
      const boundary = buffer.indexOf("\r\n\r\n");
      if (boundary < 0) break;
      const headerText = buffer.slice(0, boundary).toString("utf8");
      const headers = parseHeaders(headerText);
      const contentLength = Number(headers.get("content-length") ?? "");
      if (!Number.isFinite(contentLength) || contentLength < 0) {
        buffer = Buffer.alloc(0);
        break;
      }
      const messageStart = boundary + 4;
      const messageEnd = messageStart + contentLength;
      if (buffer.length < messageEnd) break;

      const body = buffer.slice(messageStart, messageEnd).toString("utf8");
      buffer = buffer.slice(messageEnd);

      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        writeMessage({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        });
        continue;
      }

      const response = await handleMcpRequest(parsed as {
        jsonrpc?: string;
        id?: string | number | null;
        method?: string;
        params?: Record<string, unknown>;
      });
      if (response) writeMessage(response);
    }
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  writeMessage({
    jsonrpc: "2.0",
    id: null,
    error: { code: -32000, message },
  });
  process.exit(1);
});
