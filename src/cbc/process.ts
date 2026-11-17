import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { locateCbcEntry } from "./locate.js";

export type Json = Record<string, any>;

export interface ControlRequestFromCbc {
  request_id: string;
  request: Json & { subtype: string };
}

/**
 * One cbc child process speaking stream-json on stdin/stdout.
 *
 * Events:
 *  - "message"         (msg: Json)                    every NDJSON line except control traffic
 *  - "control_request" (req: ControlRequestFromCbc)   cbc asks us something (can_use_tool, ...)
 *  - "stderr"          (text: string)
 *  - "exit"            (code: number | null, signal: string | null)
 */
export class CbcProcess extends EventEmitter {
  readonly child: ChildProcessWithoutNullStreams;
  private decoder = new StringDecoder("utf8");
  private buf = "";
  private reqSeq = 0;
  private pending = new Map<string, { resolve: (v: Json) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private stderrTail: string[] = [];
  exited = false;
  exitCode: number | null = null;

  constructor(args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }) {
    super();
    const entry = locateCbcEntry();
    this.child = spawn(process.execPath, [entry, ...args], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stdout.on("data", (d: Buffer) => this.onData(this.decoder.write(d)));
    this.child.stderr.on("data", (d: Buffer) => {
      const text = d.toString("utf8");
      for (const line of text.split(/\r?\n/)) if (line.trim()) this.stderrTail.push(line);
      if (this.stderrTail.length > 50) this.stderrTail.splice(0, this.stderrTail.length - 50);
      this.emit("stderr", text);
    });
    this.child.on("error", (e) => {
      this.stderrTail.push(`spawn error: ${e.message}`);
      this.markExit(null, null);
    });
    this.child.on("exit", (code, signal) => this.markExit(code, signal));
    this.child.stdin.on("error", () => {
      /* EPIPE after exit — ignored, exit handler reports it */
    });
  }

  get pid() {
    return this.child.pid;
  }

  get lastStderr(): string[] {
    return [...this.stderrTail];
  }

  private markExit(code: number | null, signal: NodeJS.Signals | null) {
    if (this.exited) return;
    const rest = this.buf + this.decoder.end();
    this.buf = "";
    if (rest.trim()) this.handleLine(rest);
    this.exited = true;
    this.exitCode = code;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("cbc process exited"));
    }
    this.pending.clear();
    this.emit("exit", code, signal);
  }

  private onData(chunk: string) {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (line.trim()) this.handleLine(line);
    }
  }

  private handleLine(line: string) {
    let msg: Json;
    try {
      msg = JSON.parse(line);
    } catch {
      this.emit("message", { type: "raw", text: line });
      return;
    }
    if (msg.type === "control_response") {
      const r = msg.response ?? {};
      const p = this.pending.get(r.request_id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(r.request_id);
        if (r.subtype === "error") p.reject(new Error(String(r.error ?? "control request failed")));
        else p.resolve(r.response ?? {});
      }
      return;
    }
    if (msg.type === "control_request") {
      this.emit("control_request", { request_id: msg.request_id, request: msg.request ?? {} });
      return;
    }
    if (msg.type === "control_cancel_request") {
      this.emit("control_cancel", msg.request_id);
      return;
    }
    this.emit("message", msg);
  }

  write(obj: Json) {
    if (this.exited || this.child.stdin.destroyed) throw new Error("cbc process is not running");
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }

  /** Send a control_request to cbc and await its control_response. */
  control(request: Json & { subtype: string }, timeoutMs = 30000): Promise<Json> {
    const request_id = `mcp_${++this.reqSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request_id);
        reject(new Error(`control request ${request.subtype} timed out`));
      }, timeoutMs);
      this.pending.set(request_id, { resolve, reject, timer });
      try {
        this.write({ type: "control_request", request_id, request });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(request_id);
        reject(e as Error);
      }
    });
  }

  /** Answer a control_request that cbc sent us. */
  respond(request_id: string, response: Json) {
    this.write({ type: "control_response", response: { subtype: "success", request_id, response } });
  }

  sendUser(content: Json[]) {
    this.write({ type: "user", message: { role: "user", content } });
  }

  /** Close stdin so cbc finishes gracefully. */
  endInput() {
    if (!this.child.stdin.destroyed) this.child.stdin.end();
  }

  /** Kill the whole process tree (cbc spawns shells and tools). */
  kill() {
    if (this.exited || !this.child.pid) return;
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(this.child.pid), "/T", "/F"], { windowsHide: true });
    } else {
      try {
        process.kill(-this.child.pid, "SIGKILL");
      } catch {
        this.child.kill("SIGKILL");
      }
    }
  }
}
