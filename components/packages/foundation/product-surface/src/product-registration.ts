export type ProductPresetReference = {
  presetId: string;
  presetVersion: string;
};

export type ProductHostDiscoveryContext = {
  productConfigPath?: string;
};

export type ProductHostRegistration = {
  hostId: string;
  displayName: string;
  preset: ProductPresetReference;
  resolveStateDir(context?: ProductHostDiscoveryContext): Promise<string | undefined>;
  readLatestActivity(stateDir: string): Promise<{ at?: string } | null>;
};

export type ProductRegistration = {
  productId: string;
  displayName: string;
  kind: "cli" | "mcp" | "visual" | "other";
  preset: ProductPresetReference;
};

function requiredId(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
  return normalized;
}

export function defineProductHostRegistration<T extends ProductHostRegistration>(
  registration: T,
): T {
  return Object.freeze({
    ...registration,
    hostId: requiredId(registration.hostId, "hostId"),
    displayName: requiredId(registration.displayName, "displayName"),
    preset: Object.freeze({ ...registration.preset }),
  }) as T;
}

export function defineProductRegistration<T extends ProductRegistration>(registration: T): T {
  return Object.freeze({
    ...registration,
    productId: requiredId(registration.productId, "productId"),
    displayName: requiredId(registration.displayName, "displayName"),
    preset: Object.freeze({ ...registration.preset }),
  }) as T;
}

export class ProductHostRegistry<T extends ProductHostRegistration = ProductHostRegistration> {
  readonly #registrations = new Map<string, T>();

  constructor(registrations: readonly T[]) {
    for (const registration of registrations) {
      if (this.#registrations.has(registration.hostId)) {
        throw new Error(`Duplicate product host registration '${registration.hostId}'`);
      }
      this.#registrations.set(registration.hostId, registration);
    }
  }

  list(): readonly T[] {
    return [...this.#registrations.values()];
  }

  get(hostId: string): T | undefined {
    return this.#registrations.get(hostId.trim());
  }

  parseHostId(value: string | undefined): string | undefined {
    const normalized = typeof value === "string" ? value.trim() : "";
    return normalized && this.#registrations.has(normalized) ? normalized : undefined;
  }
}
