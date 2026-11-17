// End-to-end smoke test: drives the built server through a real MCP client.
// Usage: npm run build && node test/smoke.mjs [model]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODEL = process.argv[2] ?? process.env.CBC_TEST_MODEL ?? "custom-local:cpa/gpt-6.1-terra";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "dist", "index.js")], stderr: "inherit" });
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);

let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  const body = JSON.parse(r.content[0].text);
  if (r.isError) throw new Error(`${name}: ${body.error}`);
  return body;
}
async function runToIdle(sid, cursor, onDecision) {
  const events = [];
  for (let i = 0; i < 20; i++) {
    const w = await call("cbc_wait", { session_id: sid, cursor, timeout_s: 45 });
    events.push(...w.events);
    cursor = w.next_cursor;
    for (const d of w.pending_decisions) {
      const answer = onDecision(d);
      console.log(`      decision ${d.decision_id} ${d.tool} → ${answer.action}`);
      await call("cbc_decide", { session_id: sid, decision_id: d.decision_id, ...answer });
    }
    if (w.status === "idle" || w.status === "exited") return { events, cursor, last: w };
  }
  throw new Error("turn did not finish");
}

const work = mkdtempSync(path.join(os.tmpdir(), "cbc-mcp-smoke-"));
writeFileSync(path.join(work, "a.txt"), "v0\n");
console.log("workdir", work);

const tools = await client.listTools();
check(tools.tools.length >= 15, `tools registered: ${tools.tools.length}`);

const models = await call("cbc_models", {});
check(models.count > 0, `cbc_models → ${models.count} models`);

// ---- turn 1: policy deny + rewrite + escalation ----
const start = await call("cbc_start", {
  cwd: work,
  model: MODEL,
  max_turns: 12,
  policy: {
    rules: [
      { match: { tool: "Bash", input: { command: "secret" } }, action: "deny", reason: "supervisor: no secrets" },
      { match: { tool: "Bash", input: { command: "^echo hello" } }, action: "rewrite", patch: { command: "echo REWRITTEN" } },
      { match: { tool: "Bash|PowerShell" }, action: "allow" },
      { match: { tool: "Read|Glob|Grep" }, action: "allow" },
    ],
    default_action: "escalate",
  },
  prompt:
    "Do exactly these, one tool call each, in order: 1) Bash: echo hello  2) Bash: echo secret  3) Write a new file b.txt containing: hi . Then report what each step printed or whether it failed.",
});
const sid = start.session_id;
check(!!sid, `cbc_start → ${sid}`);

const t1 = await runToIdle(sid, 0, (d) => ({ action: "allow" }));
const steps1 = (await call("cbc_steps", { session_id: sid, turn: 1 })).steps;
console.log("      steps:", JSON.stringify(steps1));
const hello = steps1.find((s) => s.tool.match(/Bash|PowerShell/) && /hello/.test(s.summary));
const secret = steps1.find((s) => /secret/.test(s.summary));
const write = steps1.find((s) => s.tool === "Write");
check(hello?.rewritten && hello.status === "ok", "rewrite rule: echo hello was rewritten and ran");
check(secret?.status === "denied" && /no secrets/.test(secret.deny_reason ?? ""), "deny rule: echo secret denied with reason");
check(write?.gate?.includes("/supervisor"), `escalation: Write decided by supervisor (${write?.gate})`);
check(existsSync(path.join(work, "b.txt")), "b.txt created after allow");
if (hello) {
  const full = await call("cbc_step", { session_id: sid, step: hello.n });
  check(/REWRITTEN/.test(full.output), `cbc_step full output contains REWRITTEN`);
}
check(/REWRITTEN/.test(t1.last.last_turn?.result ?? ""), "turn 1 result mentions REWRITTEN");

// ---- turn 2: per-turn effort override + deny-with-reason via decide ----
let denied = false;
const s2 = await call("cbc_send", { session_id: sid, text: "Read a.txt, then use Edit to change v0 to v1. If that is refused, follow the refusal reason.", effort: "low" });
const t2 = await runToIdle(sid, s2.cursor, (d) => {
  if (!denied && d.tool === "Edit") {
    denied = true;
    return { action: "deny", reason: "Use v9 instead of v1." };
  }
  return { action: "allow" };
});
const kinds2 = t2.events.map((e) => e.kind);
check(kinds2.includes("effort_set"), "per-turn effort override applied (effort_set event)");
check(readFileSync(path.join(work, "a.txt"), "utf8").trim() === "v9", `cbc adapted to deny reason: a.txt = ${readFileSync(path.join(work, "a.txt"), "utf8").trim()}`);

// ---- rewind ----
const dry = await call("cbc_rewind", { session_id: sid, to_turn: 1, dry_run: true });
check(dry.files.length >= 2, `rewind dry_run lists ${dry.files.length} files`);
check(existsSync(path.join(work, "b.txt")), "dry_run left disk untouched");
const real = await call("cbc_rewind", { session_id: sid, to_turn: 1, dry_run: false });
check(!existsSync(path.join(work, "b.txt")) && readFileSync(path.join(work, "a.txt"), "utf8").trim() === "v0", `rewind restored files (${real.files.length})`);

// ---- model switch + stop ----
const set = await call("cbc_set", { session_id: sid, model: process.env.CBC_TEST_MODEL_ALT ?? "custom-local:claude/claude-haiku-4-5" });
check(!!set.changed.model?.to, `cbc_set model → ${set.changed.model?.to}`);
const turns = await call("cbc_turns", { session_id: sid });
check(turns.length === 2 && turns.every((t) => t.rewindable), "cbc_turns lists 2 rewindable turns");
const stop = await call("cbc_stop", { session_id: sid });
check(!!stop.cbc_session_id, `cbc_stop → cbc_session_id ${stop.cbc_session_id}`);

await client.close();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
