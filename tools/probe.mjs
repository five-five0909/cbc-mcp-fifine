// Raw protocol probe: spawn cbc in stream-json mode and talk NDJSON to it by hand.
// Use it to re-verify docs/cbc-protocol.md after a cbc upgrade.
//
//   npm run build && node tools/probe.mjs [--model M] [--cwd DIR] [--persist] [--ask]
//
// Input lines:
//   plain text            → user message
//   /ctl <subtype> [json] → control_request, e.g. /ctl set_model {"model":"x"}
//   /allow | /deny why    → answer the oldest pending can_use_tool (only with --ask)
//   {...}                 → raw JSON line written as-is
//   /quit                 → close stdin and exit
// Without --ask every can_use_tool is auto-allowed. Noisy system messages are hidden.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { locateCbcEntry } from "../dist/cbc/locate.js";

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const args = [locateCbcEntry(), "-p", "--input-format", "stream-json", "--output-format", "stream-json",
  "--replay-user-messages", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--permission-mode", "default"];
if (opt("--model")) args.push("--model", opt("--model"));
if (!argv.includes("--persist")) args.push("--no-session-persistence");
const ask = argv.includes("--ask");

const p = spawn(process.execPath, args, { cwd: opt("--cwd") ?? process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
const send = (o) => { p.stdin.write(JSON.stringify(o) + "\n"); console.log(">>", JSON.stringify(o).slice(0, 300)); };
let n = 0;
const pending = [];
const dec = new StringDecoder("utf8");
let buf = "";
p.stdout.on("data", (d) => {
  buf += dec.write(d);
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { console.log("RAW", line.slice(0, 300)); continue; }
    if (j.type === "system" && ["usage_update", "status"].includes(j.subtype)) continue;
    console.log("<<", line.slice(0, 800));
    if (j.type === "control_request" && j.request?.subtype === "can_use_tool") {
      if (ask) { pending.push(j.request_id); console.log("   (pending — /allow or /deny <reason>)"); }
      else send({ type: "control_response", response: { subtype: "success", request_id: j.request_id, response: { allowed: true } } });
    }
  }
});
p.stderr.on("data", (d) => process.stderr.write("ERR " + d));
p.on("exit", (c) => { console.log("exit", c); process.exit(0); });

send({ type: "control_request", request_id: "init", request: { subtype: "initialize" } });
createInterface({ input: process.stdin }).on("line", (l) => {
  l = l.trim();
  if (!l) return;
  if (l === "/quit") return p.stdin.end();
  if (l.startsWith("{")) return send(JSON.parse(l));
  if (l.startsWith("/ctl ")) {
    const [, subtype, ...rest] = l.split(" ");
    return send({ type: "control_request", request_id: `p${++n}`, request: { subtype, ...(rest.length ? JSON.parse(rest.join(" ")) : {}) } });
  }
  if (l === "/allow" || l.startsWith("/deny")) {
    const id = pending.shift();
    if (!id) return console.log("   no pending can_use_tool");
    const response = l === "/allow" ? { allowed: true } : { allowed: false, reason: l.slice(5).trim() || "denied" };
    return send({ type: "control_response", response: { subtype: "success", request_id: id, response } });
  }
  send({ type: "user", message: { role: "user", content: [{ type: "text", text: l }] } });
});
