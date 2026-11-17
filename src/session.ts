import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CbcProcess, type ControlRequestFromCbc, type Json } from "./cbc/process.js";
import { DEFAULT_POLICY, evaluate, type Policy } from "./gate.js";

// ---------- public shapes ----------

export type SessionStatus = "starting" | "idle" | "running" | "waiting_decision" | "exited";

export type StepStatus = "proposed" | "pending_decision" | "allowed" | "denied" | "ok" | "failed" | "interrupted";

export interface Step {
  n: number;
  tool_use_id: string;
  turn: number;
  tool: string;
  input: Record<string, any>;
  summary: string;
  model?: string;
  parent_tool_use_id?: string | null;
  status: StepStatus;
  gate?: { action: string; rule: number | "default" | "n/a"; by: "policy" | "supervisor" | "timeout" | "auto" };
  rewritten_input?: Record<string, any>;
  deny_reason?: string;
  result_preview?: string;
  result_full?: string;
  is_error?: boolean;
  started_at: number;
  ended_at?: number;
}

export interface Turn {
  n: number;
  user_message_id?: string;
  prompt: string;
  started_at: number;
  ended_at?: number;
  result_subtype?: string;
  result?: string;
  is_error?: boolean;
  num_turns?: number;
  duration_ms?: number;
  usage?: Json;
  model_usage?: Json;
  permission_denials?: any[];
  structured_output?: any;
}

export interface PendingDecision {
  decision_id: string;
  request_id: string;
  step: number;
  tool_use_id: string;
  tool: string;
  input: Record<string, any>;
  proposed_input?: Record<string, any>;
  rule: number | "default";
  agent_id?: string;
  decision_reason?: any;
  created_at: number;
  expires_at: number;
  timer: NodeJS.Timeout;
}

export interface NormEvent {
  seq: number;
  t: string;
  kind: string;
  [k: string]: any;
}

export interface StartOptions {
  cwd: string;
  model?: string;
  effort?: string;
  permission_mode?: "default" | "acceptEdits" | "plan";
  max_turns?: number;
  system_prompt?: string;
  append_system_prompt?: string;
  allowed_tools?: string[];
  disallowed_tools?: string[];
  add_dirs?: string[];
  mcp_config?: string;
  json_schema?: string;
  agents?: Record<string, any>;
  fallback_model?: string;
  resume?: string;
  fork_session?: boolean;
  policy?: Policy;
  turn_timeout_s?: number;
  env?: Record<string, string>;
}

export interface SendOptions {
  model?: string;
  effort?: string;
  images?: { media_type: string; data: string }[];
}

export type WaitUntil = "idle" | "event";

// ---------- helpers ----------

const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n) + `… (+${s.length - n} chars)` : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

function summarizeToolInput(tool: string, input: Record<string, any>): string {
  if (!input || typeof input !== "object") return "";
  if (typeof input.command === "string") return trunc(oneLine(input.command), 160);
  if (typeof input.file_path === "string") {
    let s = input.file_path;
    if (typeof input.old_string === "string" && typeof input.new_string === "string")
      s += ` (replace ${input.old_string.length}→${input.new_string.length} chars${input.replace_all ? ", all" : ""})`;
    else if (typeof input.content === "string") s += ` (write ${input.content.length} chars)`;
    return s;
  }
  if (typeof input.pattern === "string") return `${input.pattern}${input.path ? " in " + input.path : ""}`;
  if (typeof input.url === "string") return input.url;
  if (typeof input.prompt === "string") return trunc(oneLine(input.prompt), 160);
  return trunc(JSON.stringify(input), 160);
}

function toolResultText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((c) => (c?.type === "text" ? c.text : c?.type === "image" ? "[image]" : JSON.stringify(c)))
      .join("\n");
  return JSON.stringify(content ?? "");
}

// ---------- session ----------

export class Session {
  readonly id: string;
  readonly opts: StartOptions;
  readonly logPath: string;
  policy: Policy;
  proc!: CbcProcess;

  cbcSessionId?: string;
  init?: Json;
  model?: string;
  effort?: string;
  permissionMode: string;

  status: SessionStatus = "starting";
  turns: Turn[] = [];
  steps: Step[] = [];
  private stepsById = new Map<string, Step>();
  decisions = new Map<string, PendingDecision>();
  private decisionSeq = 0;

  private events: NormEvent[] = [];
  private seq = 0;
  private waiters: { check: () => boolean; resolve: () => void }[] = [];
  private log?: WriteStream;

  private expectingEcho = 0;
  private turnRunning = false;
  private turnOverrides?: { model?: string; effort?: string };
  private turnTimer?: NodeJS.Timeout;
  private pendingNote?: string;
  exitInfo?: { code: number | null; stderr_tail: string[] };

  createdAt = Date.now();

  constructor(id: string, opts: StartOptions) {
    this.id = id;
    this.opts = opts;
    this.policy = opts.policy ?? DEFAULT_POLICY;
    this.model = opts.model;
    this.effort = opts.effort;
    this.permissionMode = opts.permission_mode ?? "default";
    const dir = path.join(os.tmpdir(), "cbc-mcp");
    mkdirSync(dir, { recursive: true });
    this.logPath = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`);
  }

  // ----- lifecycle -----

  buildArgs(): string[] {
    const o = this.opts;
    const a = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--replay-user-messages",
      "--strict-mcp-config",
      "--mcp-config", o.mcp_config ?? '{"mcpServers":{}}',
      "--permission-mode", this.permissionMode,
    ];
    if (o.model) a.push("--model", o.model);
    if (o.effort) a.push("--effort", o.effort);
    if (o.max_turns) a.push("--max-turns", String(o.max_turns));
    if (o.system_prompt) a.push("--system-prompt", o.system_prompt);
    if (o.append_system_prompt) a.push("--append-system-prompt", o.append_system_prompt);
    if (o.allowed_tools?.length) a.push("--allowedTools", o.allowed_tools.join(","));
    if (o.disallowed_tools?.length) a.push("--disallowedTools", o.disallowed_tools.join(","));
    if (o.add_dirs?.length) a.push("--add-dir", ...o.add_dirs);
    if (o.json_schema) a.push("--json-schema", o.json_schema);
    if (o.agents) a.push("--agents", JSON.stringify(o.agents));
    if (o.fallback_model) a.push("--fallback-model", o.fallback_model);
    if (o.resume) a.push("--resume", o.resume);
    if (o.resume && o.fork_session) a.push("--fork-session");
    return a;
  }

  async start(): Promise<void> {
    this.log = createWriteStream(this.logPath, { flags: "a" });
    this.proc = new CbcProcess(this.buildArgs(), { cwd: this.opts.cwd, env: this.opts.env });
    this.proc.on("message", (m: Json) => this.onMessage(m));
    this.proc.on("control_request", (r: ControlRequestFromCbc) => this.onControlRequest(r));
    this.proc.on("control_cancel", (rid: string) => this.onControlCancel(rid));
    this.proc.on("exit", (code: number | null) => this.onExit(code));
    try {
      await this.proc.control({ subtype: "initialize" }, 60000);
    } catch (e) {
      if (!this.proc.exited) this.proc.kill();
      throw new Error(`cbc failed to initialize: ${(e as Error).message}. stderr: ${this.proc.lastStderr.slice(-10).join(" | ")}`);
    }
    if (this.status === "starting") this.status = "idle";
    this.push({ kind: "started", pid: this.proc.pid, cwd: this.opts.cwd, model: this.model ?? "(cbc default)", permission_mode: this.permissionMode });
  }

  async stop(): Promise<void> {
    if (this.proc.exited) return;
    for (const d of [...this.decisions.values()]) this.resolveDecision(d, { allowed: false, reason: "session stopped" }, "supervisor", "deny");
    this.proc.endInput();
    await new Promise<void>((res) => {
      const t = setTimeout(() => {
        this.proc.kill();
        res();
      }, 4000);
      this.proc.once("exit", () => {
        clearTimeout(t);
        res();
      });
    });
  }

  private onExit(code: number | null) {
    this.status = "exited";
    this.turnRunning = false;
    if (this.turnTimer) clearTimeout(this.turnTimer);
    for (const d of this.decisions.values()) clearTimeout(d.timer);
    this.decisions.clear();
    this.exitInfo = { code, stderr_tail: this.proc.lastStderr.slice(-20) };
    this.push({ kind: "exit", code, stderr_tail: code ? this.exitInfo.stderr_tail.slice(-8) : undefined });
    this.log?.end();
  }

  // ----- input -----

  async send(text: string, o: SendOptions = {}): Promise<number> {
    this.assertAlive();
    if (this.turnRunning) throw new Error("a turn is already running; use cbc_steer to inject guidance mid-turn, or cbc_interrupt first");
    const overrides: { model?: string; effort?: string } = {};
    if (o.model && o.model !== this.model) {
      overrides.model = this.model;
      await this.setModel(o.model, "turn_override");
    }
    if (o.effort && o.effort !== this.effort) {
      overrides.effort = this.effort ?? "medium";
      await this.setEffort(o.effort, "turn_override");
    }
    this.turnOverrides = Object.keys(overrides).length ? overrides : undefined;

    let prompt = text;
    if (this.pendingNote) {
      prompt = `${this.pendingNote}\n\n${text}`;
      this.pendingNote = undefined;
    }
    const content: Json[] = [{ type: "text", text: prompt }];
    for (const img of o.images ?? []) content.push({ type: "image", source: { type: "base64", media_type: img.media_type, data: img.data } });

    const turn: Turn = { n: this.turns.length + 1, prompt: text, started_at: Date.now() };
    this.turns.push(turn);
    this.turnRunning = true;
    this.status = "running";
    this.expectingEcho++;
    this.proc.sendUser(content);
    this.push({ kind: "turn_start", turn: turn.n, prompt: trunc(oneLine(text), 200), model: this.model });
    if (this.opts.turn_timeout_s) {
      if (this.turnTimer) clearTimeout(this.turnTimer);
      this.turnTimer = setTimeout(() => {
        if (this.turnRunning && this.turns.at(-1) === turn) {
          this.push({ kind: "error", message: `turn ${turn.n} exceeded turn_timeout_s=${this.opts.turn_timeout_s}; interrupting` });
          this.interrupt("turn timeout").catch(() => {});
        }
      }, this.opts.turn_timeout_s * 1000);
    }
    return turn.n;
  }

  /**
   * cbc only accepts steer while the model is generating; while a tool runs it
   * answers {steered:false, reason:"idle"}. In that case the text is queued and
   * retried after each tool result; if the turn ends first it is prepended to
   * the next cbc_send.
   */
  async steer(text: string): Promise<{ steered: boolean; queued: boolean; reason?: string }> {
    this.assertAlive();
    if (!this.turnRunning) throw new Error("no turn is running; use cbc_send to start one");
    const r = await this.trySteer(text);
    if (r.steered) {
      this.push({ kind: "steer", text: trunc(oneLine(text), 200), delivered: "now" });
      return { steered: true, queued: false };
    }
    this.steerQueue.push(text);
    this.push({ kind: "steer_queued", text: trunc(oneLine(text), 200), reason: r.reason ?? "not steerable right now" });
    return { steered: false, queued: true, reason: r.reason };
  }

  private steerQueue: string[] = [];
  private flushingSteer = false;

  private async trySteer(text: string): Promise<{ steered: boolean; reason?: string }> {
    const r = await this.proc.control({ subtype: "steer", content_blocks: [{ type: "text", text }] });
    return { steered: !!r.steered, reason: r.reason };
  }

  private async flushSteerQueue() {
    if (this.flushingSteer || this.steerQueue.length === 0 || !this.turnRunning || this.proc.exited) return;
    this.flushingSteer = true;
    try {
      while (this.steerQueue.length && this.turnRunning) {
        const text = this.steerQueue[0];
        const r = await this.trySteer(text).catch(() => ({ steered: false }));
        if (!r.steered) break;
        this.steerQueue.shift();
        this.push({ kind: "steer", text: trunc(oneLine(text), 200), delivered: "after_tool" });
      }
    } finally {
      this.flushingSteer = false;
    }
  }

  // ----- control -----

  async interrupt(reason = "supervisor"): Promise<void> {
    this.assertAlive();
    for (const d of [...this.decisions.values()]) this.resolveDecision(d, { allowed: false, reason: "interrupted by supervisor", interrupt: true }, "supervisor", "deny");
    await this.proc.control({ subtype: "interrupt", reason });
    this.push({ kind: "interrupt", reason });
  }

  async setModel(model: string, reason = "manual"): Promise<{ from?: string; to: string }> {
    this.assertAlive();
    const r = await this.proc.control({ subtype: "set_model", model });
    const from = r.previous_model ?? this.model;
    this.model = r.model ?? model;
    this.push({ kind: "model_switched", from, to: this.model, reason });
    return { from, to: this.model! };
  }

  async setEffort(effort: string, reason = "manual"): Promise<void> {
    this.assertAlive();
    const r = await this.proc.control({ subtype: "set_config", config: { reasoningEffort: effort } });
    if (r.errors && Object.keys(r.errors).length) throw new Error(`set effort failed: ${JSON.stringify(r.errors)}`);
    const from = this.effort;
    this.effort = effort;
    this.push({ kind: "effort_set", from, to: effort, reason });
  }

  async setPermissionMode(mode: "default" | "acceptEdits" | "plan"): Promise<void> {
    this.assertAlive();
    await this.proc.control({ subtype: "set_permission_mode", mode });
    const from = this.permissionMode;
    this.permissionMode = mode;
    this.push({ kind: "permission_mode_set", from, to: mode });
  }

  setPolicy(policy: Policy) {
    this.policy = policy;
    this.push({ kind: "policy_set", rules: policy.rules.length, default_action: policy.default_action });
  }

  async rewind(toTurn: number, dryRun: boolean): Promise<Json> {
    this.assertAlive();
    if (!dryRun && this.turnRunning) throw new Error("cannot rewind while a turn is running; cbc_interrupt first");
    const turn = this.turns[toTurn - 1];
    if (!turn) throw new Error(`no turn ${toTurn}; this session has ${this.turns.length} turns`);
    if (!turn.user_message_id) throw new Error(`turn ${toTurn} has no user_message_id recorded (cbc did not echo it)`);
    const r = await this.proc.control({ subtype: "rewind", user_message_id: turn.user_message_id, scope: "Code", dry_run: dryRun }, 60000);
    if (!r.canRewind) throw new Error(`rewind refused: ${r.error ?? "unknown"}`);
    const out = { to_turn: toTurn, dry_run: dryRun, files: r.filesChanged ?? [], insertions: r.insertions ?? 0, deletions: r.deletions ?? 0, ...(r.fileRewindError ? { error: r.fileRewindError } : {}) };
    if (!dryRun) {
      this.pendingNote = `[supervisor note] All file changes made from turn ${toTurn} onward were reverted on disk (${out.files.length} files). Your memory of those edits is stale: re-read files before relying on them.`;
    }
    this.push({ kind: "rewind", ...out, files: out.files.length });
    return out;
  }

  decide(decisionId: string, d: { action: "allow" | "deny"; reason?: string; updated_input?: Record<string, any>; interrupt?: boolean }) {
    const pd = this.decisions.get(decisionId);
    if (!pd) throw new Error(`no pending decision ${decisionId} (already decided, timed out, or cancelled)`);
    if (d.action === "allow") {
      const input = d.updated_input ?? pd.proposed_input;
      this.resolveDecision(pd, { allowed: true, ...(input ? { updatedInput: input } : {}) }, "supervisor", "allow", input);
    } else {
      this.resolveDecision(pd, { allowed: false, reason: d.reason ?? "denied by supervisor", ...(d.interrupt ? { interrupt: true } : {}) }, "supervisor", "deny");
    }
  }

  // ----- cbc → us -----

  private onControlRequest(req: ControlRequestFromCbc) {
    const r = req.request;
    if (r.subtype !== "can_use_tool") {
      // Hooks / elicitation / sdk MCP are not used by this server: answer so cbc never hangs.
      try {
        this.proc.write({ type: "control_response", response: { subtype: "error", request_id: req.request_id, error: `cbc-mcp does not handle ${r.subtype}` } });
      } catch {}
      return;
    }
    const tool = String(r.tool_name);
    const input = (r.input ?? {}) as Record<string, any>;
    const step = this.ensureStep(String(r.tool_use_id ?? `anon_${this.steps.length + 1}`), tool, input, r.agent_id ? String(r.agent_id) : null);
    const v = evaluate(this.policy, tool, input, this.opts.cwd);
    if (v.action === "allow") {
      step.status = "allowed";
      step.gate = { action: v.updatedInput ? "rewrite+allow" : "allow", rule: v.rule, by: "policy" };
      if (v.updatedInput) step.rewritten_input = v.updatedInput;
      this.proc.respond(req.request_id, { allowed: true, ...(v.updatedInput ? { updatedInput: v.updatedInput } : {}) });
      this.push({ kind: "gate", step: step.n, tool, action: step.gate.action, rule: v.rule, ...(v.updatedInput ? { rewritten: summarizeToolInput(tool, v.updatedInput) } : {}) });
      return;
    }
    if (v.action === "deny") {
      step.status = "denied";
      step.deny_reason = v.reason;
      step.gate = { action: "deny", rule: v.rule, by: "policy" };
      this.proc.respond(req.request_id, { allowed: false, reason: v.reason });
      this.push({ kind: "gate", step: step.n, tool, action: "deny", rule: v.rule, reason: v.reason });
      return;
    }
    // escalate → hold cbc until the supervisor decides
    const id = `d${++this.decisionSeq}`;
    const timeoutMs = this.policy.escalate_timeout_s * 1000;
    const pd: PendingDecision = {
      decision_id: id,
      request_id: req.request_id,
      step: step.n,
      tool_use_id: step.tool_use_id,
      tool,
      input,
      proposed_input: v.updatedInput,
      rule: v.rule,
      agent_id: r.agent_id,
      decision_reason: r.decision_reason,
      created_at: Date.now(),
      expires_at: Date.now() + timeoutMs,
      timer: setTimeout(() => {
        const allow = this.policy.on_timeout === "allow";
        this.resolveDecision(
          pd,
          allow ? { allowed: true, ...(pd.proposed_input ? { updatedInput: pd.proposed_input } : {}) } : { allowed: false, reason: "supervisor did not answer in time" },
          "timeout",
          allow ? "allow" : "deny",
        );
      }, timeoutMs),
    };
    this.decisions.set(id, pd);
    step.status = "pending_decision";
    this.status = "waiting_decision";
    this.push({ kind: "decision_needed", decision_id: id, step: step.n, tool, summary: step.summary, rule: v.rule, expires_in_s: this.policy.escalate_timeout_s });
  }

  private onControlCancel(requestId: string) {
    for (const d of this.decisions.values()) {
      if (d.request_id === requestId) {
        clearTimeout(d.timer);
        this.decisions.delete(d.decision_id);
        const step = this.steps[d.step - 1];
        if (step && step.status === "pending_decision") step.status = "interrupted";
        this.push({ kind: "decision_cancelled", decision_id: d.decision_id, step: d.step });
      }
    }
    this.refreshStatus();
  }

  private resolveDecision(pd: PendingDecision, response: Json, by: "supervisor" | "timeout", action: "allow" | "deny", input?: Record<string, any>) {
    clearTimeout(pd.timer);
    this.decisions.delete(pd.decision_id);
    const step = this.steps[pd.step - 1];
    if (step) {
      step.status = action === "allow" ? "allowed" : "denied";
      step.gate = { action: action === "allow" && input ? "rewrite+allow" : action, rule: pd.rule, by };
      if (input) step.rewritten_input = input;
      if (action === "deny") step.deny_reason = response.reason;
    }
    try {
      this.proc.respond(pd.request_id, response);
    } catch {}
    this.push({ kind: "decided", decision_id: pd.decision_id, step: pd.step, action, by, ...(response.reason ? { reason: response.reason } : {}) });
    this.refreshStatus();
  }

  private ensureStep(toolUseId: string, tool: string, input: Record<string, any>, parent: string | null): Step {
    let step = this.stepsById.get(toolUseId);
    if (step) return step;
    step = {
      n: this.steps.length + 1,
      tool_use_id: toolUseId,
      turn: this.turns.length,
      tool,
      input,
      summary: summarizeToolInput(tool, input),
      model: this.model,
      parent_tool_use_id: parent,
      status: "proposed",
      started_at: Date.now(),
    };
    this.steps.push(step);
    this.stepsById.set(toolUseId, step);
    this.push({ kind: "tool_use", step: step.n, tool, summary: step.summary, ...(parent ? { parent } : {}) });
    return step;
  }

  private onMessage(m: Json) {
    try {
      this.log?.write(JSON.stringify(m) + "\n");
    } catch {}
    switch (m.type) {
      case "system":
        if (m.subtype === "init") {
          this.cbcSessionId = m.session_id;
          if (m.model) this.model = m.model;
          if (m.permissionMode) this.permissionMode = m.permissionMode;
          const first = !this.init;
          this.init = { model: m.model, permission_mode: m.permissionMode, tools: m.tools, mcp_servers: m.mcp_servers, cwd: m.cwd };
          if (first) this.push({ kind: "init", cbc_session_id: m.session_id, model: m.model, permission_mode: m.permissionMode, tools: (m.tools ?? []).length, mcp_servers: (m.mcp_servers ?? []).map((s: any) => `${s.name}:${s.status}`) });
        }
        return; // status / usage_update / mcp_status are noise for the supervisor
      case "assistant": {
        const msg = m.message ?? {};
        for (const c of msg.content ?? []) {
          if (c.type === "text" && c.text?.trim()) this.push({ kind: "text", turn: this.turns.length, text: trunc(c.text.trim(), 600), ...(m.parent_tool_use_id ? { parent: m.parent_tool_use_id } : {}) });
          else if (c.type === "thinking") this.push({ kind: "thinking", chars: (c.thinking ?? "").length });
          else if (c.type === "tool_use") {
            const step = this.ensureStep(c.id, c.name, c.input ?? {}, m.parent_tool_use_id ?? null);
            step.model = msg.model ?? step.model;
          }
        }
        return;
      }
      case "user": {
        const content = m.message?.content;
        const blocks = Array.isArray(content) ? content : [{ type: "text", text: String(content ?? "") }];
        const results = blocks.filter((b: any) => b?.type === "tool_result");
        if (results.length === 0) {
          // replayed user message → records the id used by rewind
          if (this.expectingEcho > 0) {
            this.expectingEcho--;
            const turn = [...this.turns].reverse().find((t) => !t.user_message_id);
            if (turn) turn.user_message_id = m.uuid;
          }
          return;
        }
        for (const b of results) {
          const step = this.stepsById.get(b.tool_use_id);
          const text = toolResultText(b.content);
          if (!step) continue;
          step.ended_at = Date.now();
          step.is_error = !!b.is_error;
          step.result_full = trunc(text, 50000);
          step.result_preview = trunc(oneLine(text), 300);
          if (step.status !== "denied") {
            // auto-approved by cbc itself (never reached the gate)
            if (!step.gate) step.gate = { action: "allow", rule: "n/a", by: "auto" };
            step.status = b.is_error ? "failed" : "ok";
          }
          this.push({ kind: "tool_result", step: step.n, tool: step.tool, status: step.status, preview: trunc(oneLine(text), 200) });
        }
        // the model is about to resume generating: good moment for queued steers
        setTimeout(() => void this.flushSteerQueue(), 50);
        return;
      }
      case "result": {
        const turn = this.turns.at(-1);
        if (turn) {
          turn.ended_at = Date.now();
          turn.result_subtype = m.subtype;
          turn.result = typeof m.result === "string" ? m.result : m.errors ? JSON.stringify(m.errors) : undefined;
          turn.is_error = !!m.is_error;
          turn.num_turns = m.num_turns;
          turn.duration_ms = m.duration_ms;
          turn.usage = m.usage;
          turn.model_usage = m.modelUsage;
          turn.permission_denials = m.permission_denials;
          if (m.structured_output !== undefined) turn.structured_output = m.structured_output;
        }
        for (const s of this.steps) if (s.status === "allowed" || s.status === "proposed") if (s.turn === turn?.n) s.status = "interrupted";
        this.turnRunning = false;
        if (this.turnTimer) clearTimeout(this.turnTimer);
        if (this.steerQueue.length) {
          const leftover = this.steerQueue.splice(0).join("\n");
          this.pendingNote = [this.pendingNote, `[supervisor note, arrived too late for the previous turn] ${leftover}`].filter(Boolean).join("\n\n");
          this.push({ kind: "steer_deferred", to: "next cbc_send" });
        }
        this.refreshStatus();
        this.push({
          kind: "turn_end",
          turn: turn?.n,
          subtype: m.subtype,
          is_error: !!m.is_error,
          result: turn?.result ? trunc(turn.result, 800) : undefined,
          duration_ms: m.duration_ms,
          tokens: m.usage ? { in: m.usage.input_tokens, out: m.usage.output_tokens, cache_read: m.usage.cache_read_input_tokens } : undefined,
        });
        this.refreshStatus();
        const ov = this.turnOverrides;
        this.turnOverrides = undefined;
        if (ov) void this.restoreOverrides(ov);
        return;
      }
      default:
        return;
    }
  }

  private async restoreOverrides(ov: { model?: string; effort?: string }) {
    try {
      if (ov.model) await this.setModel(ov.model, "restore_after_turn");
      if (ov.effort) await this.setEffort(ov.effort, "restore_after_turn");
    } catch (e) {
      this.push({ kind: "error", message: `failed to restore per-turn overrides: ${(e as Error).message}` });
    }
  }

  // ----- events / waiting -----

  private refreshStatus() {
    if (this.status === "exited") return;
    if (this.decisions.size > 0) this.status = "waiting_decision";
    else if (this.turnRunning) this.status = "running";
    else this.status = "idle";
    this.notify();
  }

  private push(e: Omit<NormEvent, "seq" | "t">) {
    const ev = { seq: ++this.seq, t: new Date().toISOString().slice(11, 19), ...e } as NormEvent;
    this.events.push(ev);
    if (this.events.length > 5000) this.events.splice(0, this.events.length - 5000);
    this.notify();
  }

  /** Re-check every waiter; called on any event AND any status change. */
  private notify() {
    for (const w of [...this.waiters]) {
      if (w.check()) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve();
      }
    }
  }

  get cursor() {
    return this.seq;
  }

  eventsSince(cursor: number, limit: number, kinds?: string[]) {
    const all = this.events.filter((e) => e.seq > cursor && (!kinds || kinds.includes(e.kind)));
    const page = all.slice(0, limit);
    return { events: page, next_cursor: page.length ? page[page.length - 1].seq : cursor, more: all.length > page.length };
  }

  async waitFor(until: WaitUntil, cursor: number, timeoutMs: number): Promise<boolean> {
    const satisfied = () => {
      if (this.status === "exited") return true;
      // cbc is blocked on us: wake as soon as something new happened (e.g. a new decision_needed),
      // but don't spin when the caller has already seen the pending decision.
      if (this.decisions.size > 0) return this.seq > cursor;
      if (until === "event") return this.seq > cursor;
      return this.status === "idle";
    };
    if (satisfied()) return true;
    return new Promise<boolean>((resolve) => {
      const w = {
        check: satisfied,
        resolve: () => {
          clearTimeout(timer);
          resolve(true);
        },
      };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(false);
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  pendingDecisions() {
    return [...this.decisions.values()].map((d) => ({
      decision_id: d.decision_id,
      step: d.step,
      tool: d.tool,
      input: d.input,
      ...(d.proposed_input ? { proposed_input: d.proposed_input } : {}),
      matched_rule: d.rule,
      ...(d.agent_id ? { subagent: d.agent_id } : {}),
      expires_in_s: Math.max(0, Math.round((d.expires_at - Date.now()) / 1000)),
    }));
  }

  snapshot() {
    const last = this.turns.at(-1);
    return {
      session_id: this.id,
      cbc_session_id: this.cbcSessionId,
      status: this.status,
      cwd: this.opts.cwd,
      model: this.model,
      effort: this.effort ?? "(default)",
      permission_mode: this.permissionMode,
      turns: this.turns.length,
      steps: this.steps.length,
      pending_decisions: this.decisions.size,
      last_turn: last
        ? { turn: last.n, running: !last.ended_at, subtype: last.result_subtype, result: last.result ? trunc(last.result, 400) : undefined }
        : undefined,
      cursor: this.seq,
      log_path: this.logPath,
      ...(this.exitInfo ? { exit: this.exitInfo } : {}),
    };
  }

  private assertAlive() {
    if (this.status === "exited" || this.proc.exited) throw new Error(`session ${this.id} has exited`);
  }
}
