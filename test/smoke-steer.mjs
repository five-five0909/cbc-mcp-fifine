// Queued steer: sent while a tool runs, must be delivered after the tool returns, in the same turn.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const client = new Client({ name: "smoke-steer", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, "dist", "index.js")], stderr: "inherit" }));
const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); const b = JSON.parse(r.content[0].text); if (r.isError) throw new Error(`${name}: ${b.error}`); return b; };
const s = await call("cbc_start", { cwd: mkdtempSync(path.join(os.tmpdir(), "cbc-mcp-steer-")), model: process.argv[2] ?? process.env.CBC_TEST_MODEL ?? "custom-local:cpa/gpt-6.1-terra", max_turns: 8,
  policy: { rules: [{ match: { tool: ".*" }, action: "allow" }], default_action: "allow" },
  prompt: "Run this Bash command: ping -n 6 127.0.0.1 . Then summarize the result in one sentence." });
let cursor = 0, w, st, kinds = [];
for (let i = 0; i < 15; i++) {
  w = await call("cbc_wait", { session_id: s.session_id, cursor, until: "event", timeout_s: 30 });
  cursor = w.next_cursor; kinds.push(...w.events.map((e) => e.kind + (e.delivered ? ":" + e.delivered : "")));
  if (!st && w.events.some((e) => e.kind === "tool_use")) st = await call("cbc_steer", { session_id: s.session_id, text: "Supervisor: end your final answer with the word KIWI." });
  if (w.status === "idle") break;
}
console.log("steer →", JSON.stringify(st)); console.log("events:", kinds.join(" "));
const ok = /KIWI/.test(w.last_turn?.result ?? "");
console.log(`${ok ? "PASS" : "FAIL"}  steer reached cbc within the same turn: ${JSON.stringify(w.last_turn?.result)}`);
await call("cbc_stop", { session_id: s.session_id }); await client.close(); process.exit(ok ? 0 : 1);
