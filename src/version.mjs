import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Read package/plugin version relative to either source checkouts or bundled plugin artifacts.
 */
export function readVersionFromModuleUrl(moduleUrl = import.meta.url) {
  const candidates = [
    "./package.json",
    "../package.json",
    "../plugin.json",
    "./plugin.json",
  ];
  for (const rel of candidates) {
    try {
      const raw = readFileSync(fileURLToPath(new URL(rel, moduleUrl)), "utf8");
      const parsed = JSON.parse(raw);
      if (typeof parsed?.version === "string" && parsed.version.trim()) {
        return parsed.version.trim();
      }
    } catch {
      // Try next candidate path.
    }
  }
  return "0.0.0";
}
