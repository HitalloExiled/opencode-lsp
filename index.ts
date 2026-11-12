/**
 * lsp — language-server navigation and diagnostics for OpenCode V2.
 *
 * V2 keeps the `lsp` config block but ships no runtime. This plugin restores
 * the two V1 behaviours from that block: the navigation tools under the `lsp`
 * namespace and error diagnostics appended to file-edit results.
 */

import { Plugin } from "@opencode/plugin";
import { createAfterToolHook, type AfterToolEvent } from "./src/hook.js";
import { LspPool } from "./src/pool.js";
import { resolveSettings } from "./src/settings.js";
import { registerTools } from "./src/tools.js";

export default Plugin.define({
  id: "lsp",
  async setup(ctx) {
    const root = String(ctx.location.directory);
    const settings = resolveSettings(root, ctx.options);
    if (settings.debug) {
      console.error(
        `[lsp] servers: ${settings.servers.map((server) => server.id).join(", ") || "none"}`,
      );
    }
    // Without a server there is nothing to ask and nothing to diagnose; the
    // tool would only ever answer with an error.
    if (settings.servers.length === 0) return;

    const pool = new LspPool(settings, root);
    const after = createAfterToolHook(pool, root, settings);
    const tools = await registerTools(ctx, pool, root, settings);
    const hook = await ctx.tool.hook("execute.after", (event) =>
      after(event as unknown as AfterToolEvent),
    );

    return async () => {
      await hook.dispose().catch(() => undefined);
      await tools.dispose().catch(() => undefined);
      await pool.shutdown().catch(() => undefined);
    };
  },
});
