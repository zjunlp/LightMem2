import type { HostRequestEnvelope } from "../model/host-request.js";
import type { HostResponseEnvelope } from "../model/host-response.js";

export type HostCodecContext = {
  headers?: Record<string, string | string[] | undefined>;
};

export type HostPayloadCodec = {
  decodeRequest(rawPayload: unknown, ctx?: HostCodecContext): HostRequestEnvelope;
  encodeRequest(envelope: HostRequestEnvelope): unknown;
  decodeResponse(rawResponse: unknown, request: HostRequestEnvelope): HostResponseEnvelope;
  encodeResponse(envelope: HostResponseEnvelope, originalRawResponse: unknown): unknown;
};
