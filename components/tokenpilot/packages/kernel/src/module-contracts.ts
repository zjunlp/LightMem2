export type ModuleExecutionStatus = "executed" | "skipped" | "failed";

export type ModuleExecutionRecord<TResult = unknown> = {
  id: string;
  status: ModuleExecutionStatus;
  result?: TResult;
  skippedReason?: string;
  error?: string;
};

export type RuntimeModuleContract<TContext, TResult = unknown> = {
  id: string;
  enabled(context: TContext): boolean;
  run(context: TContext): Promise<TResult> | TResult;
  skippedReason?: string;
  failureMode?: "isolate" | "fail_fast";
};

export type RequestModuleContract<TContext, TResult = unknown> = RuntimeModuleContract<
  TContext,
  TResult
>;

export type HistoryModuleContract<TContext, TResult = unknown> = RuntimeModuleContract<
  TContext,
  TResult
>;
