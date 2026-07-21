import type { StabilizerRequestEnvelope } from "./contracts.js";
import {
  extractContentText,
  normalizeUserMessageText,
  prependTextToContent,
  replaceContentText,
  rewriteTextForStablePrefix,
} from "./message-text.js";

export function findFirstUserMessageIndex(messages: StabilizerRequestEnvelope["messages"]): number {
  return messages.findIndex((message) => message?.role === "user");
}

export function applyStablePrefixToInstructions<TEnvelope extends StabilizerRequestEnvelope>(params: {
  envelope: TEnvelope;
  dynamicContextTarget?: "developer" | "user";
  mergeDynamicContextIntoInstructions?: boolean;
}): TEnvelope {
  const {
    envelope,
    dynamicContextTarget = "user",
    mergeDynamicContextIntoInstructions = false,
  } = params;
  const sourceInstructions = typeof envelope.instructions === "string" ? envelope.instructions : "";
  if (!sourceInstructions.trim()) return envelope;

  const rewrite = rewriteTextForStablePrefix(sourceInstructions);
  if (!rewrite.changed) return envelope;

  let nextInstructions = rewrite.forwardedText;
  let nextMessages = envelope.messages;
  let changed = nextInstructions !== sourceInstructions;

  if (rewrite.dynamicContextText && dynamicContextTarget === "developer" && mergeDynamicContextIntoInstructions) {
    nextInstructions = `${rewrite.forwardedText}\n\n${rewrite.dynamicContextText}`;
    changed = true;
  }

  if (rewrite.dynamicContextText && dynamicContextTarget === "user") {
    const userIndex = findFirstUserMessageIndex(envelope.messages);
    if (userIndex >= 0) {
      const userMessage = envelope.messages[userIndex];
      const currentText = extractContentText(userMessage.content);
      if (!currentText.includes(rewrite.dynamicContextText)) {
        nextMessages = envelope.messages.slice();
        nextMessages[userIndex] = {
          ...userMessage,
          content: prependTextToContent(userMessage.content, rewrite.dynamicContextText),
        };
        changed = true;
      }
    }
  }

  if (!changed) return envelope;
  return {
    ...envelope,
    instructions: nextInstructions,
    messages: nextMessages,
  } as TEnvelope;
}

export function applyStablePrefixToMessage<TEnvelope extends StabilizerRequestEnvelope>(params: {
  envelope: TEnvelope;
  messageIndex: number;
  dynamicContextTarget?: "developer" | "user";
  mergeDynamicContextIntoMessage?: boolean;
}): TEnvelope {
  const {
    envelope,
    messageIndex,
    dynamicContextTarget = "user",
    mergeDynamicContextIntoMessage = false,
  } = params;
  const message = envelope.messages[messageIndex];
  if (!message) return envelope;
  const sourceText = extractContentText(message.content);
  if (!sourceText.trim()) return envelope;

  const rewrite = rewriteTextForStablePrefix(sourceText);
  if (!rewrite.changed) return envelope;

  let nextMessages = envelope.messages.slice();
  let changed = false;
  const nextText =
    rewrite.dynamicContextText && dynamicContextTarget === "developer" && mergeDynamicContextIntoMessage
      ? `${rewrite.forwardedText}\n\n${rewrite.dynamicContextText}`
      : rewrite.forwardedText;
  if (nextText !== sourceText) {
    nextMessages[messageIndex] = {
      ...message,
      content: replaceContentText(message.content, nextText),
    };
    changed = true;
  }

  if (rewrite.dynamicContextText && dynamicContextTarget === "user") {
    const userIndex = findFirstUserMessageIndex(nextMessages);
    if (userIndex >= 0) {
      const userMessage = nextMessages[userIndex];
      const currentText = extractContentText(userMessage.content);
      if (!currentText.includes(rewrite.dynamicContextText)) {
        nextMessages[userIndex] = {
          ...userMessage,
          content: prependTextToContent(userMessage.content, rewrite.dynamicContextText),
        };
        changed = true;
      }
    }
  }

  if (!changed) return envelope;
  return {
    ...envelope,
    messages: nextMessages,
  } as TEnvelope;
}

function rewriteInstructions<TEnvelope extends StabilizerRequestEnvelope>(
  envelope: TEnvelope,
): {
  changed: boolean;
  instructions: string | undefined;
  dynamicContextText: string;
} {
  const instructions = typeof envelope.instructions === "string" ? envelope.instructions : "";
  if (!instructions.trim()) {
    return {
      changed: false,
      instructions: envelope.instructions,
      dynamicContextText: "",
    };
  }
  const rewrite = rewriteTextForStablePrefix(instructions);
  if (!rewrite.changed) {
    return {
      changed: false,
      instructions: envelope.instructions,
      dynamicContextText: "",
    };
  }
  return {
    changed: true,
    instructions: rewrite.forwardedText,
    dynamicContextText: rewrite.dynamicContextText,
  };
}

function rewriteSystemMessage(messages: StabilizerRequestEnvelope["messages"]): {
  changed: boolean;
  messages: StabilizerRequestEnvelope["messages"];
  dynamicContextText: string;
} {
  const systemIndex = messages.findIndex((message) => message?.role === "system");
  if (systemIndex < 0) {
    return { changed: false, messages, dynamicContextText: "" };
  }
  const systemMessage = messages[systemIndex];
  const sourceText = extractContentText(systemMessage.content);
  if (!sourceText.trim()) {
    return { changed: false, messages, dynamicContextText: "" };
  }
  const rewrite = rewriteTextForStablePrefix(sourceText);
  if (!rewrite.changed) {
    return { changed: false, messages, dynamicContextText: "" };
  }
  const nextMessages = messages.slice();
  nextMessages[systemIndex] = {
    ...systemMessage,
    content: replaceContentText(systemMessage.content, rewrite.forwardedText),
  };
  return {
    changed: true,
    messages: nextMessages,
    dynamicContextText: rewrite.dynamicContextText,
  };
}

function normalizeUserMessages(messages: StabilizerRequestEnvelope["messages"]): {
  changed: boolean;
  messages: StabilizerRequestEnvelope["messages"];
} {
  let changed = false;
  const nextMessages = messages.map((message) => {
    if (message?.role !== "user") return message;
    const sourceText = extractContentText(message.content);
    if (!sourceText.trim()) return message;
    const normalizedText = normalizeUserMessageText(sourceText);
    if (normalizedText === sourceText) return message;
    changed = true;
    return {
      ...message,
      content: replaceContentText(message.content, normalizedText),
    };
  });
  return { changed, messages: changed ? nextMessages : messages };
}

function injectDynamicContext(
  messages: StabilizerRequestEnvelope["messages"],
  dynamicContextText: string,
): {
  changed: boolean;
  messages: StabilizerRequestEnvelope["messages"];
} {
  if (!dynamicContextText.trim()) return { changed: false, messages };
  const userIndex = messages.findIndex((message) => message?.role === "user");
  if (userIndex < 0) return { changed: false, messages };
  const userMessage = messages[userIndex];
  const sourceText = extractContentText(userMessage.content);
  if (sourceText.includes(dynamicContextText)) {
    return { changed: false, messages };
  }
  const nextMessages = messages.slice();
  nextMessages[userIndex] = {
    ...userMessage,
    content: prependTextToContent(userMessage.content, dynamicContextText),
  };
  return { changed: true, messages: nextMessages };
}

export function defaultPrepareStablePrefix<TEnvelope extends StabilizerRequestEnvelope>(
  envelope: TEnvelope,
): TEnvelope {
  const instructionRewrite = rewriteInstructions(envelope);
  const sourceMessages = instructionRewrite.changed ? envelope.messages : envelope.messages;
  const systemRewrite = instructionRewrite.changed
    ? { changed: false, messages: sourceMessages, dynamicContextText: instructionRewrite.dynamicContextText }
    : rewriteSystemMessage(sourceMessages);
  const normalizedUsers = normalizeUserMessages(systemRewrite.messages);
  const dynamicContextText = instructionRewrite.dynamicContextText || systemRewrite.dynamicContextText;
  const dynamicInjection = injectDynamicContext(normalizedUsers.messages, dynamicContextText);

  const anyChanged =
    instructionRewrite.changed ||
    systemRewrite.changed ||
    normalizedUsers.changed ||
    dynamicInjection.changed;

  if (!anyChanged) return envelope;

  const nextInstructions = instructionRewrite.changed
    ? instructionRewrite.instructions
    : dynamicContextText && !dynamicInjection.changed && typeof envelope.instructions === "string"
      ? `${envelope.instructions}\n\n${dynamicContextText}`
      : envelope.instructions;

  return {
    ...envelope,
    instructions: nextInstructions,
    messages: dynamicInjection.messages,
  } as TEnvelope;
}

export function prepareStablePrefixEnvelope<TEnvelope extends StabilizerRequestEnvelope>(
  envelope: TEnvelope,
  transform?: (envelope: TEnvelope) => TEnvelope,
): { envelope: TEnvelope; applied: boolean } {
  const next = (transform ?? defaultPrepareStablePrefix)(envelope);
  return { envelope: next, applied: next !== envelope };
}
