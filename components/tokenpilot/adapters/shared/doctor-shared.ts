export function asObjectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function hookGroupHasCommandMatch(group: unknown, matcher: (command: string) => boolean): boolean {
  if (!group || typeof group !== "object") return false;
  const hooks = (group as Record<string, unknown>).hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const command = (entry as Record<string, unknown>).command;
    return typeof command === "string" && matcher(command);
  });
}

export function scanInstalledHookEvents(params: {
  hooksRoot: Record<string, unknown>;
  hookEventNames: readonly string[];
  isTokenPilotCommand(command: string): boolean;
  expectedCommand: string;
}): {
  installedHookEvents: string[];
  matchedHookEvents: string[];
  missingHookEvents: string[];
  hooksInstalled: boolean;
  hooksComplete: boolean;
  hooksMatchExpectedCommand: boolean;
} {
  const hooks = asObjectRecord(params.hooksRoot.hooks);
  const installedHookEvents: string[] = [];
  const matchedHookEvents: string[] = [];

  for (const name of params.hookEventNames) {
    const groups = hooks[name];
    if (Array.isArray(groups) && groups.some((group) => hookGroupHasCommandMatch(group, params.isTokenPilotCommand))) {
      installedHookEvents.push(name);
    }
    if (Array.isArray(groups) && groups.some((group) => hookGroupHasCommandMatch(group, (command) => command.trim() === params.expectedCommand))) {
      matchedHookEvents.push(name);
    }
  }

  const missingHookEvents = params.hookEventNames.filter((name) => !installedHookEvents.includes(name));
  const hooksComplete = missingHookEvents.length === 0;
  const hooksInstalled = installedHookEvents.length > 0;
  const hooksMatchExpectedCommand = params.hookEventNames.every((name) => matchedHookEvents.includes(name));

  return {
    installedHookEvents,
    matchedHookEvents,
    missingHookEvents,
    hooksInstalled,
    hooksComplete,
    hooksMatchExpectedCommand,
  };
}
