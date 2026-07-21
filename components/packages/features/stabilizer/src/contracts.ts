import type { RuntimeMessage } from "@lightmem2/kernel";

export type StabilizerRequestEnvelope = {
  session: {
    host: {
      hostId: string;
    };
  };
  model: string;
  instructions?: string;
  messages: RuntimeMessage[];
  tools?: unknown[];
};
