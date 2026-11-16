import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUT_DIR = path.join(ROOT, "plugins", "opencode-delegate", "mcp");

mkdirSync(OUT_DIR, { recursive: true });

await build({
  entryPoints: [path.join(ROOT, "server.mjs")],
  outfile: path.join(OUT_DIR, "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "info",
  banner: {
    js: 'import { createRequire as __ocmCreateRequire } from "node:module"; const require = __ocmCreateRequire(import.meta.url);',
  },
});
