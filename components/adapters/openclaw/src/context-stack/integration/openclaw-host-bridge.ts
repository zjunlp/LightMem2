/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  createOpenClawPayloadCodec,
  createOpenClawSessionResolver,
  createOpenClawStreamCodec,
  createOpenClawStreamSnapshot,
} from "./openclaw-host-adapter.js";

export function createOpenClawHostBridge(helpers: any) {
  const sessionResolver = createOpenClawSessionResolver({
    extractInputText: helpers.extractInputText,
  });
  const payloadCodec = createOpenClawPayloadCodec(
    {
      extractInputText: helpers.extractInputText,
    },
    sessionResolver,
  );
  const streamCodec = createOpenClawStreamCodec({
    extractProviderResponseText: helpers.extractProviderResponseText,
    contentToText: helpers.contentToText,
  });

  return {
    sessionResolver,
    payloadCodec,
    streamCodec,
    decodeRequest(rawPayload: any) {
      return payloadCodec.decodeRequest(rawPayload);
    },
    decodeResponse(rawResponse: any, rawRequest?: any) {
      const request = rawRequest ? payloadCodec.decodeRequest(rawRequest) : undefined;
      return payloadCodec.decodeResponse(rawResponse, request as any);
    },
    snapshotStream(rawStreamText: string) {
      return createOpenClawStreamSnapshot(rawStreamText, streamCodec);
    },
  };
}
