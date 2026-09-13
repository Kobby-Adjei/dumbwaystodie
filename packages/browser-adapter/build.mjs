import { build, context } from "esbuild";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";

/**
 * Bundling is required here and nowhere else in this project.
 *
 * A content script cannot use ES module imports, and a service worker cannot
 * resolve bare specifiers like `@dumbways/protocol`. The alternative to a
 * bundler is copying the block parser into the extension by hand — a second
 * implementation of the one thing that must never disagree with itself.
 */
/*
 * A build id stamped into the bundle and written beside it.
 *
 * Chrome does not reload an unpacked extension when its files change — the
 * service worker keeps running the copy it loaded. So an add-on can be several
 * builds behind while looking perfectly connected, and the symptom is not "it
 * is stale", it is a request going somewhere it should not. That took three
 * rounds to diagnose once; the id is what makes it one.
 *
 * The same value goes into the bundle (what the running add-on reports) and
 * into `build.txt` (what the editor knows it shipped). They match when the
 * add-on has been reloaded and differ when it has not.
 */
const buildId = `${JSON.parse(await readFile("public/manifest.json", "utf8")).version}-${Date.now()}`;

const shared = {
  bundle: true,
  format: "esm",
  target: "chrome116",
  logLevel: "info",
  outdir: "dist",
  define: { __DWTD_BUILD__: JSON.stringify(buildId) },
};

const entries = ["src/background.ts", "src/content.ts", "src/popup.ts"];

async function copyStatic() {
  await mkdir("dist", { recursive: true });
  for (const file of ["manifest.json", "popup.html", "popup.css"]) {
    await cp(`public/${file}`, `dist/${file}`);
  }
  await writeFile("dist/build.txt", buildId);
}

if (process.argv.includes("--watch")) {
  await copyStatic();
  const ctx = await context({ ...shared, entryPoints: entries });
  await ctx.watch();
  console.log("[browser-adapter] watching");
} else {
  await copyStatic();
  // The content script must not be a module: MV3 injects it as a classic
  // script, so it is bundled separately with everything inlined.
  await build({ ...shared, entryPoints: ["src/background.ts", "src/popup.ts"] });
  await build({ ...shared, format: "iife", entryPoints: ["src/content.ts"] });
  console.log("[browser-adapter] built to dist/");
}
