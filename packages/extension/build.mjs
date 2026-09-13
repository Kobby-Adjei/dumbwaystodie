import { build } from "esbuild";
import { cp, rm, mkdir } from "node:fs/promises";

/**
 * Packaging build.
 *
 * `tsc` alone cannot produce an installable extension here: the editor code
 * imports `@dumbways/protocol`, `@dumbways/relay` and `@dumbways/mock-provider`
 * through npm workspace symlinks, and a `.vsix` has no node_modules to resolve
 * them from. Everything is bundled instead.
 *
 * Three separate outputs, because they are three separate processes:
 *
 *  - `extension.js` runs inside the editor's extension host;
 *  - `relay-server.js` and `mock-provider.js` are spawned with `node`, so they
 *    have to remain real files on disk rather than being folded into the
 *    extension bundle;
 *  - `browser-extension/` is copied in whole so the add-on can be installed
 *    from an installed copy of this extension, with no repo present.
 */

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  // Provided by the editor at runtime; bundling it would break everything.
  external: ["vscode", "bufferutil", "utf-8-validate"],
  logLevel: "info",
  sourcemap: true,
};

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

await build({ ...common, entryPoints: ["src/extension.ts"], outfile: "dist/extension.js" });

await build({
  ...common,
  entryPoints: ["../relay/src/server.ts"],
  outfile: "dist/relay-server.js",
});

await build({
  ...common,
  entryPoints: ["../mock-provider/src/standalone.ts"],
  outfile: "dist/mock-provider.js",
});

// The browser add-on ships inside this extension so "Set Up Browser Extension"
// works for someone who installed a .vsix and has never seen this repository.
await build({ ...common, entryPoints: ["../mcp-server/src/server.ts"], outfile: "dist/mcp-server.js" });

/*
 * The panel's renderer is hand-written JS and cannot import from src/, but the
 * diagram splitter must not exist twice — a heuristic with two copies drifts,
 * and here that would mean the panel disagreeing with its own tests. So the
 * one implementation is bundled for the browser and loaded alongside it.
 */
await build({
  bundle: true,
  platform: "browser",
  target: "es2020",
  format: "iife",
  logLevel: "info",
  entryPoints: ["src/ui/prose.browser.ts"],
  outfile: "media/prose.generated.js",
});

await cp("../browser-adapter/dist", "dist/browser-extension", { recursive: true });

console.log("[extension] bundled to dist/ (extension, relay, provider, browser add-on)");
