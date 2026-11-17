import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const PKG_BIN = path.join("node_modules", "@tencent-ai", "codebuddy-code", "bin", "codebuddy");

let cached: string | undefined;

/**
 * Resolve the JS entry of cbc so we can spawn it with `node` directly.
 * Spawning the `cbc.cmd` shim on Windows needs a shell, which mangles JSON
 * arguments, so we never go through it.
 */
export function locateCbcEntry(): string {
  if (cached) return cached;
  const fromEnv = process.env.CBC_ENTRY;
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw new Error(`CBC_ENTRY does not exist: ${fromEnv}`);
    return (cached = fromEnv);
  }
  // 1) next to a `cbc` / `codebuddy` shim on PATH
  const exts = process.platform === "win32" ? [".cmd", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of ["cbc", "codebuddy"]) {
      for (const ext of exts) {
        if (existsSync(path.join(dir, name + ext))) {
          const candidate = path.join(dir, PKG_BIN);
          if (existsSync(candidate)) return (cached = candidate);
          const libCandidate = path.join(dir, "..", "lib", PKG_BIN);
          if (existsSync(libCandidate)) return (cached = libCandidate);
        }
      }
    }
  }
  // 2) npm global root
  try {
    const root = execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["root", "-g"], {
      encoding: "utf8",
      shell: process.platform === "win32",
      timeout: 15000,
    }).trim();
    const candidate = path.join(root, "@tencent-ai", "codebuddy-code", "bin", "codebuddy");
    if (existsSync(candidate)) return (cached = candidate);
  } catch {
    /* fall through */
  }
  throw new Error(
    "Could not find the CodeBuddy Code entry. Install it with `npm i -g @tencent-ai/codebuddy-code` or set CBC_ENTRY to .../@tencent-ai/codebuddy-code/bin/codebuddy",
  );
}
