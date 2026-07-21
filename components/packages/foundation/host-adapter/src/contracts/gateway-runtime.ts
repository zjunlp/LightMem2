import type { Readable } from "node:stream";

export type HostGatewayProtocol =
  | "openai-responses"
  | "anthropic-messages"
  | "custom";

export type HostGatewayUpstreamConfig = {
  baseUrl: string;
  apiKey?: string;
  name?: string;
  protocol: HostGatewayProtocol;
};

export type HostGatewayHttpResponse = {
  status: number;
  headers: Record<string, string>;
  text: string;
};

export type HostGatewayStreamResponse = {
  status: number;
  headers: Record<string, string>;
  stream: Readable;
};

export type HostGatewayStreamSnapshot = {
  assistantText: string;
  usage?: Record<string, unknown>;
  rawStreamText: string;
  metadata?: Record<string, unknown>;
};

export type HostGatewayForwarder = {
  request(
    params: {
      upstream: HostGatewayUpstreamConfig;
      payload: unknown;
      inboundAuthorization?: string;
      inboundHeaders?: Record<string, string | string[] | undefined>;
    },
  ): Promise<HostGatewayHttpResponse>;
  requestStream(
    params: {
      upstream: HostGatewayUpstreamConfig;
      payload: unknown;
      inboundAuthorization?: string;
      inboundHeaders?: Record<string, string | string[] | undefined>;
    },
  ): Promise<HostGatewayStreamResponse>;
};

export type HostGatewayStreamObserver = {
  snapshot(rawStreamText: string): HostGatewayStreamSnapshot;
};
