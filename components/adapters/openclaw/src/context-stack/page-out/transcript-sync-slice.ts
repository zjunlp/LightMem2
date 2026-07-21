export function sliceMessagesForCurrentUserTurn(messages: any[]): any[] {
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const role = String(messages[i]?.role ?? "").toLowerCase();
    if (role === "user") {
      lastUserIndex = i;
      break;
    }
  }
  return lastUserIndex >= 0 ? messages.slice(lastUserIndex) : messages;
}

export function sliceMessagesForTurnSeq(messages: any[], turnSeq: number): any[] {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const userIndices: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const role = String(messages[i]?.role ?? "").toLowerCase();
    if (role === "user") userIndices.push(i);
  }
  if (userIndices.length === 0) return [];
  const turnIndex = Math.max(0, turnSeq - 1);
  if (turnIndex >= userIndices.length) return [];
  const start = userIndices[turnIndex]!;
  const endExclusive = turnIndex + 1 < userIndices.length ? userIndices[turnIndex + 1]! : messages.length;
  return messages.slice(start, endExclusive);
}
