#!/usr/bin/env node
import path from "node:path";
import { existsSync, statSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CbcProcess } from "./cbc/process.js";
import { DEFAULT_POLICY, PolicySchema, READ_ONLY_TOOLS, RuleSchema } from "./gate.js";
import { Session, type Step } from "./session.js";

// ---------------- config ----------------

const MAX_SESSIONS = Number(process.env.CBC_MCP_MAX_SESSIONS ?? 4);
const ALLOWED_ROOTS = (process.env.CBC_MCP_ALLOWED_ROOTS ?? "")
  .split(path.delimiter)
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => path.resolve(s));
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

const sessions = new Map<string, Session>();
let sessionSeq = 0;

// ---------------- helpers ----------------

const ok = (obj: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj) }] });
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }], isError: true });

function wrap<A>(fn: (a: A) => Promise<unknown> | unknown) {
  return async (a: A) => {
    try {
      return ok(await fn(a));
    } catch (e) {
      return fail((e as Error).message);
    }
  };
}

function getSession(id: string): Session {
  const s = sessions.get(id);
  if (!s) throw new Error(`unknown session_id ${id}. Known: ${[...sessions.keys()].join(", ") || "(none)"}`);
  return s;
}

function checkCwd(cwd: string): string {
  if (!path.isAbsolute(cwd)) throw new Error("cwd must be an absolute path");
  const abs = path.resolve(cwd);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`cwd does not exist or is not a directory: ${abs}`);
  if (ALLOWED_ROOTS.length) {
    const inside = ALLOWED_ROOTS.some((r) => {
      const rel = path.relative(r, abs);
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    });
    if (!inside) throw new Error(`cwd is outside CBC_MCP_ALLOWED_ROOTS (${ALLOWED_ROOTS.join(", ")})`);
  }
  return abs;
}

function hint(s: Session): string {
  if (s.status === "waiting_decision") return "cbc is blocked on a tool call: answer with cbc_decide (see pending_decisions)";
  if (s.status === "running") return "turn still running: call cbc_wait again with next_cursor (or cbc_steer / cbc_interrupt)";
  if (s.status === "idle") return "turn finished: read last_turn.result, inspect cbc_steps / cbc_step, then cbc_send a follow-up or cbc_stop";
  if (s.status === "exited") return "process exited: start a new session (cbc_start with resume=cbc_session_id to continue the conversation)";
  return "";
}

async function waitView(s: Session, cursor: number, timeoutS: number, until: "idle" | "event", limit: number) {
  const done = await s.waitFor(until, cursor, timeoutS * 1000);
  const page = s.eventsSince(cursor, limit);
  const snap = s.snapshot();
  return {
    session_id: s.id,
    status: s.status,
    timed_out: !done,
    events: page.events,
    next_cursor: page.next_cursor,
    more_events: page.more,
    pending_decisions: s.pendingDecisions(),
    last_turn: snap.last_turn,
    hint: page.more ? "more events available: call cbc_events with next_cursor" : hint(s),
  };
}

function stepRow(st: Step) {
  return {
    n: st.n,
    turn: st.turn,
    tool: st.tool,
    summary: st.summary,
    status: st.status,
    gate: st.gate ? `${st.gate.action}${st.gate.rule === "n/a" ? "" : `#${st.gate.rule}`}/${st.gate.by}` : undefined,
    ...(st.rewritten_input ? { rewritten: true } : {}),
    ...(st.deny_reason ? { deny_reason: st.deny_reason } : {}),
    ...(st.result_preview ? { result: st.result_preview.slice(0, 160) } : {}),
    ...(st.parent_tool_use_id ? { subagent_of: st.parent_tool_use_id } : {}),
    ms: st.ended_at ? st.ended_at - st.started_at : undefined,
  };
}

// ---------------- models (cached) ----------------

let modelCache: { at: number; models: any[] } | undefined;

async function listModels(): Promise<any[]> {
  if (modelCache && Date.now() - modelCache.at < 10 * 60 * 1000) return modelCache.models;
  const live = [...sessions.values()].find((s) => s.status !== "exited" && s.status !== "starting");
  let res: any;
  if (live) {
    res = await live.proc.control({ subtype: "get_available_models" });
  } else {
    const p = new CbcProcess(
      ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--no-session-persistence"],
      { cwd: process.cwd() },
    );
    try {
      await p.control({ subtype: "initialize" }, 60000);
      res = await p.control({ subtype: "get_available_models" }, 30000);
    } finally {
      p.kill();
    }
  }
  const raw: any[] = res.rawModels ?? [];
  const models = (res.availableModels ?? []).map((m: any) => {
    const r = raw.find((x) => x.id === m.modelId) ?? {};
    return {
      id: m.modelId,
      name: m.name,
      ...(m.description ? { description: m.description } : {}),
      ...(r.contextWindow ?? r.maxInputTokens ? { context_window: r.contextWindow ?? r.maxInputTokens } : {}),
    };
  });
  modelCache = { at: Date.now(), models };
  return models;
}

// ---------------- server ----------------

const server = new McpServer(
  { name: "cbc-mcp", version: "0.1.0" },
  {
    instructions: [
      "Drives CodeBuddy Code (cbc) as a supervised worker agent with step-level control.",
      "Flow: cbc_start (with a policy) → cbc_send → loop cbc_wait until status=idle; whenever pending_decisions is non-empty cbc is BLOCKED on that tool call, answer it with cbc_decide.",
      "Prefer declaring rules in the policy over answering every call: only escalations reach you.",
      "Mid-turn guidance: cbc_steer. Abort: cbc_interrupt. Undo file edits since turn N: cbc_rewind (dry_run first). Model/effort: cbc_set or per-turn in cbc_send.",
      "Inspect work with cbc_steps (table) and cbc_step (full input/output of one call).",
    ].join("\n"),
  },
);

server.registerTool(
  "cbc_models",
  {
    title: "List cbc models",
    description: "List model ids cbc can use (for cbc_start.model, cbc_set.model, cbc_send.model). Cached 10 minutes.",
    inputSchema: { query: z.string().optional().describe("Case-insensitive substring filter on id/name") },
  },
  wrap(async ({ query }: { query?: string }) => {
    const all = await listModels();
    const q = query?.toLowerCase();
    const models = q ? all.filter((m) => `${m.id} ${m.name}`.toLowerCase().includes(q)) : all;
    return { count: models.length, models, note: "reasoning effort is verified to apply on OpenAI-style models; on claude/* models its effect is unverified" };
  }),
);

server.registerTool(
  "cbc_start",
  {
    title: "Start a cbc session",
    description:
      "Spawn a cbc worker in `cwd`. Every tool call it wants to make goes through the gate `policy` (allow/deny/rewrite/escalate). Default policy: read-only tools inside cwd allowed, everything else escalated to you. Optionally send the first `prompt` and wait up to `wait_s` seconds.",
    inputSchema: {
      cwd: z.string().describe("Absolute working directory for cbc"),
      prompt: z.string().optional().describe("First user message (optional; else use cbc_send)"),
      wait_s: z.number().int().min(0).max(50).default(0).describe("If prompt is given, wait this long for progress before returning"),
      model: z.string().optional().describe("Model id from cbc_models"),
      effort: z.enum(EFFORTS).optional(),
      fallback_model: z.string().optional(),
      permission_mode: z
        .enum(["default", "acceptEdits", "plan"])
        .default("default")
        .describe("default = every non-trivial tool call reaches the gate. acceptEdits lets cbc auto-approve edits (they bypass the gate). plan = read-only planning"),
      policy: PolicySchema.optional().describe("Gate policy. Rules are evaluated top-down; first allow/deny/escalate wins, rewrite patches input and continues"),
      max_turns: z.number().int().min(1).max(500).optional().describe("cbc --max-turns (agentic steps per user message)"),
      turn_timeout_s: z.number().int().min(10).max(7200).optional().describe("Auto-interrupt a turn that runs longer than this"),
      append_system_prompt: z.string().optional(),
      system_prompt: z.string().optional().describe("Replaces cbc's system prompt entirely (use with care)"),
      allowed_tools: z.array(z.string()).optional().describe('cbc --allowedTools, e.g. ["Bash(git:*)","Edit"]'),
      disallowed_tools: z.array(z.string()).optional().describe("cbc --disallowedTools: these tools are removed from cbc entirely"),
      add_dirs: z.array(z.string()).optional(),
      mcp_config: z.string().optional().describe('JSON for MCP servers cbc may use. Default {"mcpServers":{}} — user-global MCP servers are never inherited'),
      json_schema: z.string().optional().describe("JSON Schema the final answer must satisfy (structured output)"),
      agents: z.record(z.any()).optional().describe('Custom subagents, e.g. {"reviewer":{"description":"...","prompt":"...","model":"deep-model"}}'),
      resume: z.string().optional().describe("cbc_session_id of an earlier session to continue"),
      fork_session: z.boolean().optional().describe("With resume: continue under a new cbc session id (branch the conversation)"),
    },
  },
  wrap(async (a: any) => {
    const live = [...sessions.values()].filter((s) => s.status !== "exited").length;
    if (live >= MAX_SESSIONS) throw new Error(`too many live sessions (${live}/${MAX_SESSIONS}); cbc_stop one first`);
    const cwd = checkCwd(a.cwd);
    const id = `s${++sessionSeq}`;
    const s = new Session(id, { ...a, cwd, policy: a.policy ?? DEFAULT_POLICY });
    sessions.set(id, s);
    try {
      await s.start();
    } catch (e) {
      sessions.delete(id);
      throw e;
    }
    if (a.prompt) {
      const cursor = 0;
      await s.send(a.prompt);
      if (a.wait_s > 0) return { ...(await waitView(s, cursor, a.wait_s, "idle", 40)), policy_rules: s.policy.rules.length };
    }
    return { ...s.snapshot(), policy_rules: s.policy.rules.length, hint: a.prompt ? "call cbc_wait" : "call cbc_send" };
  }),
);

server.registerTool(
  "cbc_send",
  {
    title: "Send a user message",
    description: "Start a new turn with a user message. Only when status is idle (use cbc_steer while running). Optional per-turn model/effort override, restored after the turn.",
    inputSchema: {
      session_id: z.string(),
      text: z.string(),
      model: z.string().optional().describe("Use this model for this turn only"),
      effort: z.enum(EFFORTS).optional().describe("Use this reasoning effort for this turn only"),
      images: z.array(z.object({ media_type: z.string(), data: z.string().describe("base64") })).optional(),
      wait_s: z.number().int().min(0).max(50).default(0).describe("Wait this long for progress before returning"),
    },
  },
  wrap(async (a: any) => {
    const s = getSession(a.session_id);
    const cursor = s.cursor;
    const turn = await s.send(a.text, { model: a.model, effort: a.effort, images: a.images });
    if (a.wait_s > 0) return { turn, ...(await waitView(s, cursor, a.wait_s, "idle", 40)) };
    return { turn, status: s.status, cursor, hint: "call cbc_wait with this cursor" };
  }),
);

server.registerTool(
  "cbc_wait",
  {
    title: "Wait for progress",
    description:
      "Long-poll a session. Returns when: until=idle → the turn ended (or cbc needs a decision, or exited); until=event → any new event. Always returns new events since `cursor` and any pending_decisions (cbc is blocked on those).",
    inputSchema: {
      session_id: z.string(),
      cursor: z.number().int().min(0).default(0).describe("next_cursor from the previous call"),
      until: z.enum(["idle", "event"]).default("idle"),
      timeout_s: z.number().int().min(1).max(50).default(45),
      limit: z.number().int().min(1).max(200).default(40).describe("Max events returned"),
    },
  },
  wrap(async (a: any) => waitView(getSession(a.session_id), a.cursor, a.timeout_s, a.until, a.limit)),
);

server.registerTool(
  "cbc_decide",
  {
    title: "Decide an escalated tool call",
    description: "Answer a pending decision. allow (optionally with updated_input to rewrite the call), or deny with a reason cbc's model will read. deny+interrupt also stops the turn.",
    inputSchema: {
      session_id: z.string(),
      decision_id: z.string(),
      action: z.enum(["allow", "deny"]),
      reason: z.string().optional().describe("For deny: explanation shown to cbc so it can adapt"),
      updated_input: z.record(z.any()).optional().describe("For allow: full replacement tool_input"),
      interrupt: z.boolean().optional().describe("For deny: also abort the current turn"),
      steer: z.string().optional().describe("Also inject this guidance into the running turn"),
      wait_s: z.number().int().min(0).max(50).default(0),
    },
  },
  wrap(async (a: any) => {
    const s = getSession(a.session_id);
    const cursor = s.cursor;
    s.decide(a.decision_id, { action: a.action, reason: a.reason, updated_input: a.updated_input, interrupt: a.interrupt });
    let steered: unknown;
    if (a.steer && s.status !== "exited") steered = await s.steer(a.steer).catch((e: Error) => ({ steered: false, error: e.message }));
    if (a.wait_s > 0) return { decided: a.decision_id, steered, ...(await waitView(s, cursor, a.wait_s, "idle", 40)) };
    return { decided: a.decision_id, steered, status: s.status, cursor, pending_decisions: s.pendingDecisions() };
  }),
);

server.registerTool(
  "cbc_steer",
  {
    title: "Steer the running turn",
    description: "Inject guidance into the turn that is running right now, without waiting for it to end.",
    inputSchema: { session_id: z.string(), text: z.string() },
  },
  wrap(async (a: any) => getSession(a.session_id).steer(a.text)),
);

server.registerTool(
  "cbc_interrupt",
  {
    title: "Interrupt the running turn",
    description: "Abort the current turn (pending decisions are denied). The session stays alive for cbc_send.",
    inputSchema: { session_id: z.string(), reason: z.string().optional() },
  },
  wrap(async (a: any) => {
    const s = getSession(a.session_id);
    await s.interrupt(a.reason);
    return { status: s.status };
  }),
);

server.registerTool(
  "cbc_set",
  {
    title: "Change model / effort / permission mode / policy",
    description: "Change settings of a live session. Takes effect from the next model request. Only process-local settings are touched; cbc's global settings files are never written.",
    inputSchema: {
      session_id: z.string(),
      model: z.string().optional(),
      effort: z.enum(EFFORTS).optional(),
      permission_mode: z.enum(["default", "acceptEdits", "plan"]).optional(),
      policy: PolicySchema.optional().describe("Replace the whole gate policy"),
      add_rules: z.array(RuleSchema).optional().describe("Prepend rules to the current policy (highest priority)"),
    },
  },
  wrap(async (a: any) => {
    const s = getSession(a.session_id);
    const changed: Record<string, unknown> = {};
    if (a.model) changed.model = await s.setModel(a.model);
    if (a.effort) {
      await s.setEffort(a.effort);
      changed.effort = a.effort;
    }
    if (a.permission_mode) {
      await s.setPermissionMode(a.permission_mode);
      changed.permission_mode = a.permission_mode;
    }
    if (a.policy) {
      s.setPolicy(PolicySchema.parse(a.policy));
      changed.policy = "replaced";
    }
    if (a.add_rules?.length) {
      s.setPolicy({ ...s.policy, rules: [...a.add_rules, ...s.policy.rules] });
      changed.add_rules = a.add_rules.length;
    }
    return { changed, session: s.snapshot() };
  }),
);

server.registerTool(
  "cbc_policy",
  {
    title: "Show gate policy",
    description: "Show the current gate policy of a session (rules are numbered from 0; gate results reference them as #n).",
    inputSchema: { session_id: z.string() },
  },
  wrap(async (a: any) => ({ policy: getSession(a.session_id).policy, read_only_tools: READ_ONLY_TOOLS })),
);

server.registerTool(
  "cbc_steps",
  {
    title: "List tool-call steps",
    description: "Ledger of every tool call cbc proposed: tool, summary, gate verdict, status, result preview. Filter to keep output small.",
    inputSchema: {
      session_id: z.string(),
      turn: z.number().int().optional(),
      tool: z.string().optional().describe("Regex on tool name"),
      status: z.array(z.enum(["proposed", "pending_decision", "allowed", "denied", "ok", "failed", "interrupted"])).optional(),
      from_step: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).max(200).default(50),
    },
  },
  wrap(async (a: any) => {
    const s = getSession(a.session_id);
    let re: RegExp | undefined;
    if (a.tool) re = new RegExp(a.tool);
    const rows = s.steps
      .filter((st) => (a.turn ? st.turn === a.turn : true) && (re ? re.test(st.tool) : true) && (a.status ? a.status.includes(st.status) : true) && (a.from_step ? st.n >= a.from_step : true))
      .slice(0, a.limit)
      .map(stepRow);
    return { total_steps: s.steps.length, steps: rows };
  }),
);

server.registerTool(
  "cbc_step",
  {
    title: "Show one step in full",
    description: "Full tool_input (and rewritten input) plus the full tool output of one step.",
    inputSchema: { session_id: z.string(), step: z.number().int().min(1), max_output_chars: z.number().int().min(100).max(50000).default(8000) },
  },
  wrap(async (a: any) => {
    const st = getSession(a.session_id).steps[a.step - 1];
    if (!st) throw new Error(`no step ${a.step}`);
    const out = st.result_full ?? "";
    return {
      ...stepRow(st),
      tool_use_id: st.tool_use_id,
      model: st.model,
      input: st.input,
      ...(st.rewritten_input ? { rewritten_input: st.rewritten_input } : {}),
      is_error: st.is_error,
      output: out.length > a.max_output_chars ? out.slice(0, a.max_output_chars) + `… (+${out.length - a.max_output_chars} chars)` : out,
    };
  }),
);

server.registerTool(
  "cbc_events",
  {
    title: "Read events",
    description: "Page through the normalized event stream (no waiting). Use kinds to filter, e.g. [\"text\",\"turn_end\"].",
    inputSchema: {
      session_id: z.string(),
      cursor: z.number().int().min(0).default(0),
      kinds: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(500).default(100),
    },
  },
  wrap(async (a: any) => getSession(a.session_id).eventsSince(a.cursor, a.limit, a.kinds)),
);

server.registerTool(
  "cbc_turns",
  {
    title: "List turns",
    description: "Per-turn summary: prompt, result, subtype, duration, token usage per model, permission denials, structured output.",
    inputSchema: { session_id: z.string(), turn: z.number().int().optional() },
  },
  wrap(async (a: any) => {
    const s = getSession(a.session_id);
    const turns = a.turn ? s.turns.filter((t) => t.n === a.turn) : s.turns;
    return turns.map((t) => ({
      turn: t.n,
      prompt: t.prompt.length > 300 ? t.prompt.slice(0, 300) + "…" : t.prompt,
      running: !t.ended_at,
      subtype: t.result_subtype,
      is_error: t.is_error,
      result: t.result,
      duration_ms: t.duration_ms,
      steps: s.steps.filter((st) => st.turn === t.n).length,
      usage: t.usage ? { in: t.usage.input_tokens, out: t.usage.output_tokens, cache_read: t.usage.cache_read_input_tokens } : undefined,
      model_usage: t.model_usage,
      permission_denials: t.permission_denials?.length ? t.permission_denials : undefined,
      structured_output: t.structured_output,
      rewindable: !!t.user_message_id,
    }));
  }),
);

server.registerTool(
  "cbc_rewind",
  {
    title: "Rewind file changes",
    description:
      "Revert files on disk to their state right before turn `to_turn` started (undoes that turn and every later one). Conversation history is NOT rewound (broken in cbc 2.184); instead cbc is told on the next cbc_send that its edits were reverted. Always try dry_run first.",
    inputSchema: { session_id: z.string(), to_turn: z.number().int().min(1), dry_run: z.boolean().default(true) },
  },
  wrap(async (a: any) => getSession(a.session_id).rewind(a.to_turn, a.dry_run)),
);

server.registerTool(
  "cbc_list",
  {
    title: "List sessions",
    description: "All sessions of this server with status, model, turn/step counts and pending decisions.",
    inputSchema: { session_id: z.string().optional() },
  },
  wrap(async (a: any) => (a.session_id ? getSession(a.session_id).snapshot() : [...sessions.values()].map((s) => s.snapshot()))),
);

server.registerTool(
  "cbc_stop",
  {
    title: "Stop a session",
    description: "End the cbc process (graceful, then kill the process tree). Its cbc_session_id can later be resumed with cbc_start.resume.",
    inputSchema: { session_id: z.string(), forget: z.boolean().default(false).describe("Also drop it from cbc_list") },
  },
  wrap(async (a: any) => {
    const s = getSession(a.session_id);
    await s.stop();
    if (a.forget) sessions.delete(a.session_id);
    return { stopped: a.session_id, cbc_session_id: s.cbcSessionId, turns: s.turns.length, steps: s.steps.length };
  }),
);

// ---------------- lifecycle ----------------

function killAll() {
  for (const s of sessions.values()) {
    try {
      s.proc?.kill();
    } catch {}
  }
}
process.on("exit", killAll);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => process.exit(0));
process.stdin.on("close", () => process.exit(0));

await server.connect(new StdioServerTransport());
