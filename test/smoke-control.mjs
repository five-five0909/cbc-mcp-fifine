// Control-path test: escalation timeout, steer and interrupt through the MCP server.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODEL = process.argv[2] ?? process.env.CBC_TEST_MODEL ?? "custom-local:cpa/gpt-6.1-terra";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const client = new Client({ name: "smoke-control", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, "dist", "index.js")], stderr: "inherit" }));
let failures = 0;
const check = (c, l) => (console.log(`${c ? "PASS" : "FAIL"}  ${l}`), c || failures++);
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const b = JSON.parse(r.content[0].text);
  if (r.isError) throw new Error(`${name}: ${b.error}`);
  return b;
};
const work = mkdtempSync(path.join(os.tmpdir(), "cbc-mcp-ctl-"));

// 1) escalation timeout → on_timeout deny
const s = await call("cbc_start", {
  cwd: work,
  model: MODEL,
  max_turns: 6,
  policy: { rules: [], default_action: "escalate", escalate_timeout_s: 5, on_timeout: "deny" },
  prompt: "Use the Write tool once to create t.txt containing x. If it is refused, do not retry; just say REFUSED.",
});
const sid = s.session_id;
let cursor = 0, sawDecision = false, w;
for (let i = 0; i < 10; i++) {
  w = await call("cbc_wait", { session_id: sid, cursor, timeout_s: 30 });
  cursor = w.next_cursor;
  if (w.pending_decisions.length) sawDecision = true; // deliberately not answering
  if (w.status === "idle") break;
}
const steps = (await call("cbc_steps", { session_id: sid })).steps;
check(sawDecision, "write was escalated");
check(steps.some((st) => st.tool === "Write" && st.status === "denied" && st.gate.endsWith("/timeout")), `unanswered decision denied by timeout (${steps.map((x) => x.gate).join(",")})`);

// 2) steer during a running turn, then interrupt a long command
await call("cbc_set", { session_id: sid, policy: { rules: [{ match: { tool: ".*" }, action: "allow" }], default_action: "allow" } });
const sent = await call("cbc_send", {
  session_id: sid,
  text: "Run this Bash command and wait for it: ping -n 40 127.0.0.1 . Then say DONE.",
});
cursor = sent.cursor;
let steered = false, interrupted = false;
for (let i = 0; i < 12; i++) {
  w = await call("cbc_wait", { session_id: sid, cursor, until: "event", timeout_s: 20 });
  cursor = w.next_cursor;
  if (!steered && w.status === "running" && w.events.some((e) => e.kind === "tool_use")) {
    const st = await call("cbc_steer", { session_id: sid, text: "Note from supervisor: when you finish, end with the word KIWI." }); steered = st.steered || st.queued; console.log("      steer →", JSON.stringify(st));
    await new Promise((r) => setTimeout(r, 3000));
    await call("cbc_interrupt", { session_id: sid, reason: "smoke test" });
    interrupted = true;
  }
  if (w.status === "idle" && interrupted) break;
}
const t0 = Date.now();
check(steered, "steer accepted mid-turn");
check(interrupted && w.status === "idle", `interrupt returned session to idle (status=${w.status})`);
const turns = await call("cbc_turns", { session_id: sid, turn: 2 });
check(turns[0] && !turns[0].running, `turn 2 ended after interrupt (subtype=${turns[0]?.subtype}, ${turns[0]?.duration_ms}ms)`);

// 3) session still usable after interrupt
const again = await call("cbc_send", { session_id: sid, text: "Reply with just: alive", wait_s: 50 });
check(/alive/i.test(again.last_turn?.result ?? ""), `session usable after interrupt: ${again.last_turn?.result}`);

await call("cbc_stop", { session_id: sid });
await client.close();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
