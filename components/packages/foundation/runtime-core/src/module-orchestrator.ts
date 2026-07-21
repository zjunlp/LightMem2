import type {
  HistoryModuleContract,
  ModuleExecutionRecord,
  RequestModuleContract,
  RuntimeModuleContract,
} from "@lightmem2/kernel";

export async function runModulesInOrder<TContext>(params: {
  context: TContext;
  modules: Array<RuntimeModuleContract<TContext, any>>;
  onRecord?(record: ModuleExecutionRecord): Promise<void> | void;
}): Promise<ModuleExecutionRecord[]> {
  const records: ModuleExecutionRecord[] = [];
  for (const module of params.modules) {
    let record: ModuleExecutionRecord;
    if (!module.enabled(params.context)) {
      record = {
        id: module.id,
        status: "skipped",
        skippedReason: module.skippedReason ?? "module_disabled",
      };
    } else {
      try {
        record = {
          id: module.id,
          status: "executed",
          result: await module.run(params.context),
        };
      } catch (error) {
        record = {
          id: module.id,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
        records.push(record);
        await params.onRecord?.(record);
        if (module.failureMode !== "isolate") throw error;
        continue;
      }
    }
    records.push(record);
    await params.onRecord?.(record);
  }
  return records;
}

export function runRequestModules<TContext>(params: {
  context: TContext;
  modules: Array<RequestModuleContract<TContext, any>>;
  onRecord?(record: ModuleExecutionRecord): Promise<void> | void;
}) {
  return runModulesInOrder(params);
}

export function runHistoryModules<TContext>(params: {
  context: TContext;
  modules: Array<HistoryModuleContract<TContext, any>>;
  onRecord?(record: ModuleExecutionRecord): Promise<void> | void;
}) {
  return runModulesInOrder(params);
}
