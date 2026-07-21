import type { RuntimeMessage } from "@tokenpilot/kernel";

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
