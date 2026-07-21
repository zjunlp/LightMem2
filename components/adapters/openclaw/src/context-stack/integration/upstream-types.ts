import type { Readable } from "node:stream";

export type UpstreamModelDef = {
  id: string;
  name: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  contextWindow: number;
  maxTokens: number;
};

export type UpstreamConfig = {
  providerId: string;
  baseUrl: string;
  apiKey: string;
  apiFamily?: string;
  models: UpstreamModelDef[];
};

export type UpstreamHttpResponse = {
  status: number;
  headers: Record<string, string>;
  text: string;
  transport: "fetch" | "curl";
};

export type UpstreamStreamResponse = {
  status: number;
  headers: Record<string, string>;
  stream: Readable;
  transport: "fetch";
};
