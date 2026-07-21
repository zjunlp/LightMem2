export type ProductCommandContext = any;

export type ProductSurfacePayload = {
  kind:
    | "text"
    | "status"
    | "report"
    | "doctor"
    | "visual";
  data?: Record<string, unknown>;
};

export type ProductCommandResult = {
  text: string;
  payload?: ProductSurfacePayload;
};

export type ProductSurfaceConfigAdapter = {
  pluginConfigRecord(config: Record<string, unknown>): Record<string, unknown> | undefined;
  pluginEntryRecord(config: Record<string, unknown>): Record<string, unknown> | undefined;
  ensurePluginConfig(config: Record<string, unknown>): Record<string, unknown>;
  ensurePluginEntry(config: Record<string, unknown>): Record<string, unknown>;
  resolveStateDir(config: Record<string, unknown>): string | undefined;
  setRuntimeHostDefaults?(config: Record<string, unknown>): void;
};

export type ProductSurfaceConfigStore = {
  loadConfig(): Promise<Record<string, unknown>> | Record<string, unknown>;
  writeConfig(nextConfig: Record<string, unknown>): Promise<void>;
};

export type ProductSurfaceHostFeatures = {
  buildReportPayload?(
    ctx: ProductCommandContext,
    currentConfig: Record<string, unknown>,
  ): Promise<ProductSurfacePayload> | ProductSurfacePayload;
  handleReport?(
    ctx: ProductCommandContext,
    currentConfig: Record<string, unknown>,
  ): Promise<ProductCommandResult> | ProductCommandResult;
  buildDoctorPayload?(
    currentConfig: Record<string, unknown>,
  ): Promise<ProductSurfacePayload> | ProductSurfacePayload;
  handleDoctor?(
    currentConfig: Record<string, unknown>,
  ): Promise<ProductCommandResult> | ProductCommandResult;
  buildVisualPayload?(
    currentConfig: Record<string, unknown>,
  ): Promise<ProductSurfacePayload> | ProductSurfacePayload;
  handleVisual?(
    currentConfig: Record<string, unknown>,
  ): Promise<ProductCommandResult> | ProductCommandResult;
};

export type ProductSurfaceHostBridge =
  & ProductSurfaceConfigStore
  & ProductSurfaceHostFeatures;

export type ProductCommandHandler = (
  ctx: ProductCommandContext,
) => Promise<ProductCommandResult> | ProductCommandResult;

export type ProductCommandSpec = {
  name: string;
  description: string;
  acceptsArgs?: boolean;
  handler: ProductCommandHandler;
};

export type ProductCommandRegistrar = {
  registerCommand(spec: ProductCommandSpec): void;
};
