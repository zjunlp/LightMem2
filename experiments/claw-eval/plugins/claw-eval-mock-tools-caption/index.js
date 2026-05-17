// @ts-nocheck
/**
 * Per-service shim: re-exports only the caption tools from claw-eval-mock-tools.
 */
import allToolsPlugin from "../claw-eval-mock-tools/index.js";

export default {
  id: "claw-eval-mock-tools-caption",
  name: "Claw-Eval Mock Tools: caption",
  description: "Registers only the caption mock service tools as OpenClaw tools.",

  register(api) {
    if (typeof api.registerTool !== "function") {
      if (api.logger) api.logger.warn("[claw-eval-mock-tools-caption] registerTool unavailable.");
      return;
    }

    const filteredApi = new Proxy(api, {
      get(target, prop) {
        if (prop === "__clawEvalShimRegister") return true;
        if (prop !== "registerTool") return target[prop];
        return (factory, opts) => {
          const toolName = (opts && opts.name) || "";
          if (toolName.startsWith("caption_")) {
            return target.registerTool(factory, opts);
          }
        };
      },
    });

    if (allToolsPlugin && typeof allToolsPlugin.register === "function") {
      allToolsPlugin.register(filteredApi);
    } else if (typeof allToolsPlugin === "function") {
      allToolsPlugin(filteredApi);
    } else {
      if (api.logger) api.logger.warn("[claw-eval-mock-tools-caption] unexpected main plugin export shape.");
      return;
    }

    if (api.logger) api.logger.info("[claw-eval-mock-tools-caption] caption tools registered.");
  },
};
