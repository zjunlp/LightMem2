// @ts-nocheck
/**
 * Per-service shim: re-exports only the inventory tools from claw-eval-mock-tools.
 */
import allToolsPlugin from "../claw-eval-mock-tools/index.js";

export default {
  id: "claw-eval-mock-tools-inventory",
  name: "Claw-Eval Mock Tools: inventory",
  description: "Registers only the inventory mock service tools as OpenClaw tools.",

  register(api) {
    if (typeof api.registerTool !== "function") {
      if (api.logger) api.logger.warn("[claw-eval-mock-tools-inventory] registerTool unavailable.");
      return;
    }

    const filteredApi = new Proxy(api, {
      get(target, prop) {
        if (prop !== "registerTool") return target[prop];
        return (factory, opts) => {
          const toolName = (opts && opts.name) || "";
          if (toolName.startsWith("inventory_")) {
            return target.registerTool(factory, opts);
          }
        };
      },
    });

    if (allToolsPlugin && typeof allToolsPlugin.register === "function") {
      allToolsPlugin.register(filteredApi);
    } else if (typeof allToolsPlugin === "function") {
      // Backward compatibility if main plugin exports function form.
      allToolsPlugin(filteredApi);
    } else {
      if (api.logger) api.logger.warn("[claw-eval-mock-tools-inventory] unexpected main plugin export shape.");
      return;
    }

    if (api.logger) api.logger.info("[claw-eval-mock-tools-inventory] inventory tools registered.");
  },
};
