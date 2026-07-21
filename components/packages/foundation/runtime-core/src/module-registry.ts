export type RuntimeModuleRegistration<TInstance = unknown> = {
  id: string;
  version: string;
  instance: TInstance;
};

export class RuntimeModuleRegistry {
  private readonly registrations = new Map<string, RuntimeModuleRegistration>();

  register<TInstance>(registration: RuntimeModuleRegistration<TInstance>): TInstance {
    const id = registration.id.trim();
    const version = registration.version.trim();
    if (!id) throw new Error("module_registry_invalid_id");
    if (!version) throw new Error(`module_registry_invalid_version:${id}`);

    const existing = this.registrations.get(id);
    if (!existing) {
      this.registrations.set(id, { ...registration, id, version });
      return registration.instance;
    }
    if (existing.version !== version) {
      throw new Error(`module_registry_version_conflict:${id}:${existing.version}:${version}`);
    }
    return existing.instance as TInstance;
  }

  get<TInstance = unknown>(id: string): TInstance | undefined {
    return this.registrations.get(id)?.instance as TInstance | undefined;
  }

  list(): RuntimeModuleRegistration[] {
    return [...this.registrations.values()];
  }
}
