export type TokenPilotProductCommandContext = any;

export type TokenPilotProductSurfacePayload = {
  kind:
    | "text"
    | "status"
    | "report"
    | "doctor"
    | "visual";
  data?: Record<string, unknown>;
};

export type TokenPilotProductCommandResult = {
  text: string;
  payload?: TokenPilotProductSurfacePayload;
};

export type TokenPilotProductSurfaceConfigAdapter = {
  pluginConfigRecord(config: Record<string, unknown>): Record<string, unknown> | undefined;
  pluginEntryRecord(config: Record<string, unknown>): Record<string, unknown> | undefined;
  ensurePluginConfig(config: Record<string, unknown>): Record<string, unknown>;
  ensurePluginEntry(config: Record<string, unknown>): Record<string, unknown>;
  resolveStateDir(config: Record<string, unknown>): string | undefined;
  setRuntimeHostDefaults?(config: Record<string, unknown>): void;
};

export type TokenPilotProductSurfaceConfigStore = {
  loadConfig(): Promise<Record<string, unknown>> | Record<string, unknown>;
  writeConfig(nextConfig: Record<string, unknown>): Promise<void>;
};

export type TokenPilotProductSurfaceHostFeatures = {
  buildReportPayload?(
    ctx: TokenPilotProductCommandContext,
    currentConfig: Record<string, unknown>,
  ): Promise<TokenPilotProductSurfacePayload> | TokenPilotProductSurfacePayload;
  handleReport?(
    ctx: TokenPilotProductCommandContext,
    currentConfig: Record<string, unknown>,
  ): Promise<TokenPilotProductCommandResult> | TokenPilotProductCommandResult;
  buildDoctorPayload?(
    currentConfig: Record<string, unknown>,
  ): Promise<TokenPilotProductSurfacePayload> | TokenPilotProductSurfacePayload;
  handleDoctor?(
    currentConfig: Record<string, unknown>,
  ): Promise<TokenPilotProductCommandResult> | TokenPilotProductCommandResult;
  buildVisualPayload?(
    currentConfig: Record<string, unknown>,
  ): Promise<TokenPilotProductSurfacePayload> | TokenPilotProductSurfacePayload;
  handleVisual?(
    currentConfig: Record<string, unknown>,
  ): Promise<TokenPilotProductCommandResult> | TokenPilotProductCommandResult;
};

export type TokenPilotProductSurfaceHostBridge =
  & TokenPilotProductSurfaceConfigStore
  & TokenPilotProductSurfaceHostFeatures;

export type TokenPilotProductCommandHandler = (
  ctx: TokenPilotProductCommandContext,
) => Promise<TokenPilotProductCommandResult> | TokenPilotProductCommandResult;

export type TokenPilotRegisteredCommandSpec = {
  name: string;
  description: string;
  acceptsArgs?: boolean;
  handler: TokenPilotProductCommandHandler;
};

export type TokenPilotProductCommandRegistrar = {
  registerCommand(spec: TokenPilotRegisteredCommandSpec): void;
};
