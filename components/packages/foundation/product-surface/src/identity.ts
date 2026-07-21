export type ProductCommandAliasSpec = {
  name: string;
  description: string;
};

export type ProductSurfaceIdentity = {
  displayName: string;
  commandName: string;
  aliases: readonly ProductCommandAliasSpec[];
};

export function productCommand(identity: ProductSurfaceIdentity): string {
  return `/${identity.commandName}`;
}
