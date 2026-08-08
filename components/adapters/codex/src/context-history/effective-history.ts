import { readCodexContextHistoryJournalRecoveringTail } from "./journal-append.js";
import { codexReplayabilityForItem, codexReplayPairRef } from "./replayability.js";
import { cloneJson, hashJson } from "./shared.js";
import type {
  CodexContextHistoryJournalEntry,
  CodexEffectiveHistory,
  CodexEffectiveHistoryItem,
  CodexRequestJournalEntry,
  CodexResponseJournalEntry,
  JsonObject,
} from "./types.js";

type IndexedRequest = {
  entry: CodexRequestJournalEntry;
  journalIndex: number;
};

type IndexedResponse = {
  entry: CodexResponseJournalEntry;
  journalIndex: number;
};

type CommittedTurn = {
  request: IndexedRequest;
  response: IndexedResponse;
};

function findLastResponse(
  responses: IndexedResponse[],
  predicate: (response: IndexedResponse) => boolean,
): IndexedResponse | undefined {
  for (let index = responses.length - 1; index >= 0; index -= 1) {
    const response = responses[index];
    if (response && predicate(response)) return response;
  }
  return undefined;
}

function latestRequests(journal: CodexContextHistoryJournalEntry[]): Map<string, IndexedRequest> {
  const requests = new Map<string, IndexedRequest>();
  journal.forEach((entry, journalIndex) => {
    if (entry.kind === "request") requests.set(entry.requestId, { entry, journalIndex });
  });
  return requests;
}

function responsesById(journal: CodexContextHistoryJournalEntry[]): Map<string, IndexedResponse[]> {
  const responses = new Map<string, IndexedResponse[]>();
  journal.forEach((entry, journalIndex) => {
    if (entry.kind === "response" && entry.responseId) {
      const occurrences = responses.get(entry.responseId) ?? [];
      occurrences.push({ entry, journalIndex });
      responses.set(entry.responseId, occurrences);
    }
  });
  return responses;
}

function isCommittedResponseEntry(entry: CodexResponseJournalEntry): boolean {
  if (entry.status === "completed") return true;
  return entry.status === "incomplete"
    && (entry.malformedEventCount ?? 0) > 0
    && (entry.eventTypeCounts?.["response.completed"] ?? 0) > 0;
}

function committedResponses(
  responses: Map<string, IndexedResponse[]>,
  requests: Map<string, IndexedRequest>,
): IndexedResponse[] {
  return Array.from(responses.values()).flat()
    .filter(({ entry }) => {
      if (!isCommittedResponseEntry(entry) || !entry.requestId) return false;
      return requests.get(entry.requestId)?.entry.status === "completed";
    })
    .sort((left, right) => left.journalIndex - right.journalIndex);
}

function previousResponseId(turn: CommittedTurn): string | undefined {
  if ("previousResponseId" in turn.response.entry) {
    return typeof turn.response.entry.previousResponseId === "string"
      ? turn.response.entry.previousResponseId
      : undefined;
  }
  return turn.request.entry.previousResponseId;
}

function committedInputItems(turn: CommittedTurn): JsonObject[] {
  return turn.request.entry.committedInputItems ?? turn.request.entry.inputItems;
}

function buildCommittedChain(params: {
  headResponseId?: string;
  requests: Map<string, IndexedRequest>;
  responses: Map<string, IndexedResponse[]>;
}): { chain: CommittedTurn[]; complete: boolean } {
  const committed = committedResponses(params.responses, params.requests);
  const head = params.headResponseId
    ? findLastResponse(committed, ({ entry }) => entry.responseId === params.headResponseId)
    : committed.at(-1);
  if (!head) {
    return { chain: [], complete: params.headResponseId === undefined && params.requests.size === 0 };
  }

  const chain: CommittedTurn[] = [];
  const seenJournalIndexes = new Set<number>();
  let cursor: IndexedResponse | undefined = head;
  while (cursor) {
    const responseId = cursor.entry.responseId;
    const requestId = cursor.entry.requestId;
    if (!responseId || !requestId || !isCommittedResponseEntry(cursor.entry)) {
      return { chain: [], complete: false };
    }
    if (seenJournalIndexes.has(cursor.journalIndex)) return { chain: [], complete: false };
    seenJournalIndexes.add(cursor.journalIndex);

    const request = params.requests.get(requestId);
    if (!request || request.entry.status !== "completed") {
      return { chain: [], complete: false };
    }
    const turn = { request, response: cursor };
    chain.unshift(turn);

    const previousId = previousResponseId(turn);
    if (!previousId) break;
    cursor = findLastResponse(committed, (candidate) => (
      candidate.entry.responseId === previousId
      && candidate.journalIndex < cursor!.journalIndex
    ));
    if (!cursor) return { chain, complete: false };
  }
  return { chain, complete: true };
}

function itemIdentity(params: {
  item: JsonObject;
  sessionId: string;
  turnOrdinal: number;
  phase: "input" | "output";
  itemOrdinal: number;
}): string {
  const type = typeof params.item.type === "string"
    ? params.item.type
    : typeof params.item.role === "string"
      ? `message:${params.item.role}`
      : "item";
  if (typeof params.item.id === "string") return `${type}:id:${params.item.id}`;
  if (typeof params.item.call_id === "string") return `${type}:call:${params.item.call_id}`;
  return `${type}:synthetic:${hashJson({
    sessionId: params.sessionId,
    type,
    turnOrdinal: params.turnOrdinal,
    phase: params.phase,
    itemOrdinal: params.itemOrdinal,
    item: params.item,
  })}`;
}

function appendEffectiveItem(params: {
  item: JsonObject;
  sessionId: string;
  turnOrdinal: number;
  phase: "input" | "output";
  itemOrdinal: number;
  seen: Set<string>;
  replayableItems: CodexEffectiveHistoryItem[];
  observationOnlyItems: CodexEffectiveHistoryItem[];
  deferredItems: CodexEffectiveHistoryItem[];
}): void {
  const nativeId = itemIdentity(params);
  if (params.seen.has(nativeId)) return;
  params.seen.add(nativeId);
  const effectiveItem: CodexEffectiveHistoryItem = {
    stableItemId: `codex-${hashJson(nativeId)}`,
    nativeId,
    callId: typeof params.item.call_id === "string" ? params.item.call_id : undefined,
    item: cloneJson(params.item),
  };
  const replayability = codexReplayabilityForItem(params.item);
  if (replayability.mode === "replayable") params.replayableItems.push(effectiveItem);
  else if (replayability.mode === "observation_only") params.observationOnlyItems.push(effectiveItem);
  else params.deferredItems.push(effectiveItem);
}

function unresolvedCallIds(items: CodexEffectiveHistoryItem[]): string[] {
  const calls = new Set<string>();
  const outputs = new Set<string>();
  for (const entry of items) {
    const ref = codexReplayPairRef(entry.item);
    if (ref.side === "call" && ref.callId) calls.add(ref.callId);
    if (ref.side === "output" && ref.callId) outputs.add(ref.callId);
  }
  return Array.from(calls).filter((callId) => !outputs.has(callId)).sort();
}

function hasUncommittedActiveWork(params: {
  chain: CommittedTurn[];
  currentRequestId?: string;
  explicitHead: boolean;
  requests: Map<string, IndexedRequest>;
}): boolean {
  const headTurnOrdinal = params.chain.at(-1)?.request.entry.turnOrdinal ?? 0;
  const committedRequestIds = new Set(params.chain.map((turn) => turn.request.entry.requestId));
  return Array.from(params.requests.values()).some(({ entry }) => {
    if (entry.requestId === params.currentRequestId || entry.status === "failed") return false;
    if (committedRequestIds.has(entry.requestId)) return false;
    if (params.explicitHead) return false;
    if (entry.turnOrdinal <= headTurnOrdinal) return false;
    return true;
  });
}

function hasUncommittedResponseWork(params: {
  chain: CommittedTurn[];
  explicitHead: boolean;
  journal: CodexContextHistoryJournalEntry[];
  requests: Map<string, IndexedRequest>;
}): boolean {
  if (params.explicitHead) return false;
  const headJournalIndex = params.chain.at(-1)?.response.journalIndex ?? -1;
  return params.journal.some((entry, journalIndex) => {
    if (journalIndex <= headJournalIndex || entry.kind !== "response" || entry.status === "failed") return false;
    if (!entry.requestId) return true;
    return params.requests.get(entry.requestId)?.entry.status !== "failed";
  });
}

function hasMalformedStreamEvents(chain: CommittedTurn[]): boolean {
  return chain.some((turn) => (turn.response.entry.malformedEventCount ?? 0) > 0);
}

function effectiveItemKeys(entry: CodexEffectiveHistoryItem): string[] {
  const type = typeof entry.item.type === "string"
    ? entry.item.type
    : typeof entry.item.role === "string"
      ? `message:${entry.item.role}`
      : "item";
  const keys = [`stable:${entry.stableItemId}`];
  if (entry.nativeId) keys.push(`native:${entry.nativeId}`);
  if (typeof entry.item.id === "string") keys.push(`item:${type}:${entry.item.id}`);
  if (entry.callId) keys.push(`call:${type}:${entry.callId}`);
  return keys;
}

function appendMergedEffectiveItems(params: {
  target: CodexEffectiveHistoryItem[];
  entries: CodexEffectiveHistoryItem[];
  seen: Set<string>;
}): void {
  for (const entry of params.entries) {
    const keys = effectiveItemKeys(entry);
    if (keys.some((key) => params.seen.has(key))) continue;
    keys.forEach((key) => params.seen.add(key));
    params.target.push({
      ...entry,
      item: cloneJson(entry.item),
    });
  }
}

function historyRevision(params: {
  replayableItems: CodexEffectiveHistoryItem[];
  observationOnlyItems: CodexEffectiveHistoryItem[];
  deferredItems: CodexEffectiveHistoryItem[];
  unresolved: string[];
  incomplete: boolean;
}): string {
  return `rev-${hashJson({
    replayableItems: params.replayableItems.map((entry) => ({
      stableItemId: entry.stableItemId,
      fingerprint: hashJson(entry.item),
    })),
    observationOnlyItems: params.observationOnlyItems.map((entry) => ({
      stableItemId: entry.stableItemId,
      fingerprint: hashJson(entry.item),
    })),
    deferredItems: params.deferredItems.map((entry) => ({
      stableItemId: entry.stableItemId,
      fingerprint: hashJson(entry.item),
    })),
    unresolved: params.unresolved,
    incomplete: params.incomplete,
  })}`;
}

function mergeRolloutBootstrapWithProxyJournal(params: {
  bootstrapped: CodexEffectiveHistory;
  proxyReplayableItems: CodexEffectiveHistoryItem[];
  proxyObservationOnlyItems: CodexEffectiveHistoryItem[];
  proxyDeferredItems: CodexEffectiveHistoryItem[];
  proxyIncomplete: boolean;
}): CodexEffectiveHistory {
  const seen = new Set<string>();
  const replayableItems: CodexEffectiveHistoryItem[] = [];
  const observationOnlyItems: CodexEffectiveHistoryItem[] = [];
  const deferredItems: CodexEffectiveHistoryItem[] = [];
  appendMergedEffectiveItems({
    target: replayableItems,
    entries: params.bootstrapped.replayableItems,
    seen,
  });
  appendMergedEffectiveItems({
    target: observationOnlyItems,
    entries: params.bootstrapped.observationOnlyItems,
    seen,
  });
  appendMergedEffectiveItems({
    target: deferredItems,
    entries: params.bootstrapped.deferredItems,
    seen,
  });
  appendMergedEffectiveItems({
    target: replayableItems,
    entries: params.proxyReplayableItems,
    seen,
  });
  appendMergedEffectiveItems({
    target: observationOnlyItems,
    entries: params.proxyObservationOnlyItems,
    seen,
  });
  appendMergedEffectiveItems({
    target: deferredItems,
    entries: params.proxyDeferredItems,
    seen,
  });
  const unresolved = Array.from(new Set([
    ...params.bootstrapped.unresolvedCallIds,
    ...unresolvedCallIds(replayableItems),
  ])).sort();
  const incomplete = Boolean(
    params.bootstrapped.incomplete
    || params.proxyIncomplete
    || deferredItems.length > 0
    || unresolved.length > 0
  );
  return {
    revision: historyRevision({
      replayableItems,
      observationOnlyItems,
      deferredItems,
      unresolved,
      incomplete,
    }),
    replayableItems,
    observationOnlyItems,
    deferredItems,
    unresolvedCallIds: unresolved,
    source: "rollout_proxy_merge",
    incomplete,
  };
}

export async function buildCodexEffectiveHistory(params: {
  stateDir: string;
  sessionId: string;
  headResponseId?: string;
  currentRequestId?: string;
  rolloutParserBootstrap?: () => Promise<CodexEffectiveHistory | null>;
}): Promise<CodexEffectiveHistory> {
  const journalRead = await readCodexContextHistoryJournalRecoveringTail(params.stateDir, params.sessionId);
  const requests = latestRequests(journalRead.entries);
  const responses = responsesById(journalRead.entries);
  const committedChain = buildCommittedChain({
    headResponseId: params.headResponseId,
    requests,
    responses,
  });
  const malformedStreams = hasMalformedStreamEvents(committedChain.chain);
  const emptyChainWithJournal = Boolean(
    committedChain.chain.length === 0
    && journalRead.entries.some((entry) => (
      entry.status !== "failed"
      && !(entry.kind === "request" && entry.requestId === params.currentRequestId)
    ))
  );
  const uncommittedActiveWork = hasUncommittedActiveWork({
    chain: committedChain.chain,
    currentRequestId: params.currentRequestId,
    explicitHead: params.headResponseId !== undefined,
    requests,
  });
  const uncommittedResponseWork = hasUncommittedResponseWork({
    chain: committedChain.chain,
    explicitHead: params.headResponseId !== undefined,
    journal: journalRead.entries,
    requests,
  });
  const journalIncomplete = Boolean(
    journalRead.readError
    || journalRead.malformedLineCount > 0
    || malformedStreams
    || !committedChain.complete
    || emptyChainWithJournal
    || uncommittedActiveWork
    || uncommittedResponseWork,
  );
  const replayableItems: CodexEffectiveHistoryItem[] = [];
  const observationOnlyItems: CodexEffectiveHistoryItem[] = [];
  const deferredItems: CodexEffectiveHistoryItem[] = [];
  const seen = new Set<string>();
  for (const turn of committedChain.chain) {
    committedInputItems(turn).forEach((item, itemOrdinal) => {
      appendEffectiveItem({
        item,
        sessionId: params.sessionId,
        turnOrdinal: turn.request.entry.turnOrdinal,
        phase: "input",
        itemOrdinal,
        seen,
        replayableItems,
        observationOnlyItems,
        deferredItems,
      });
    });
    turn.response.entry.outputItems.forEach((item, itemOrdinal) => {
      appendEffectiveItem({
        item,
        sessionId: params.sessionId,
        turnOrdinal: turn.request.entry.turnOrdinal,
        phase: "output",
        itemOrdinal,
        seen,
        replayableItems,
        observationOnlyItems,
        deferredItems,
      });
    });
  }

  const unresolved = unresolvedCallIds(replayableItems);
  const effectiveIncomplete = journalIncomplete || deferredItems.length > 0 || unresolved.length > 0;
  if ((journalRead.entries.length === 0 || effectiveIncomplete) && params.rolloutParserBootstrap) {
    const bootstrapped = await params.rolloutParserBootstrap();
    if (bootstrapped) {
      if (committedChain.chain.length === 0) return bootstrapped;
      return mergeRolloutBootstrapWithProxyJournal({
        bootstrapped,
        proxyReplayableItems: replayableItems,
        proxyObservationOnlyItems: observationOnlyItems,
        proxyDeferredItems: deferredItems,
        proxyIncomplete: Boolean(
          journalRead.readError
          || journalRead.malformedLineCount > 0
          || malformedStreams
          || emptyChainWithJournal
          || uncommittedActiveWork
          || uncommittedResponseWork
        ),
      });
    }
  }
  const revision = historyRevision({
    replayableItems,
    observationOnlyItems,
    deferredItems,
    unresolved,
    incomplete: effectiveIncomplete,
  });

  return {
    revision,
    replayableItems,
    observationOnlyItems,
    deferredItems,
    unresolvedCallIds: unresolved,
    source: journalRead.entries.length > 0 ? "proxy_journal" : "empty",
    incomplete: effectiveIncomplete,
  };
}
