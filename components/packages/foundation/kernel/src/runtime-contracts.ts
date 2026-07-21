export type RuntimeMessageRole = "system" | "user" | "assistant" | "tool";

export type RuntimeContentBlock =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image";
      imageUrl?: string;
      mediaType?: string;
      alt?: string;
    }
  | {
      type: "tool_call";
      toolCallId: string;
      toolName: string;
      argumentsText?: string;
      argumentsJson?: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      toolCallId?: string;
      toolName?: string;
      status?: "success" | "error";
      text: string;
    };

export type RuntimeMessage = {
  messageId?: string;
  role: RuntimeMessageRole;
  content: string | RuntimeContentBlock[];
  createdAt?: string;
  metadata?: Record<string, unknown>;
};

export type RuntimeToolCall = {
  toolCallId: string;
  toolName: string;
  argumentsText?: string;
  argumentsJson?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type RuntimeToolResult = {
  toolCallId?: string;
  toolName?: string;
  status: "success" | "error";
  content: string | RuntimeContentBlock[];
  metadata?: Record<string, unknown>;
};

export type RuntimeSessionRef = {
  runtime: string;
  sessionId: string;
  sessionKey?: string;
  branchId?: string;
  metadata?: Record<string, unknown>;
};

export type TranscriptTurn = {
  session: RuntimeSessionRef;
  turnId: string;
  turnSeq: number;
  userMessage?: RuntimeMessage;
  assistantMessages: RuntimeMessage[];
  toolCalls: RuntimeToolCall[];
  toolResults: RuntimeToolResult[];
  metadata?: Record<string, unknown>;
};
