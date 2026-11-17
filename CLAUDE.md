# cbc-mcp

MCP server (TypeScript, stdio) that lets Claude drive **CodeBuddy Code (`cbc`, npm `@tencent-ai/codebuddy-code`)** as a supervised executor: every tool call cbc wants to make passes through a Gate that Claude controls (allow / deny with reason / rewrite input / escalate to Claude). Claude can also steer, interrupt, switch model/effort mid-session, rewind files, and audit every step.

User-facing docs are in `README.md` (Chinese). cbc protocol facts we measured are in `docs/cbc-protocol.md` — **read that before touching anything that talks to cbc.**

## Commands

```bash
npm install
npm run build          # tsc → dist/
npm test               # build + 3 smoke tests; needs cbc logged in, calls real models (~1 min)
npm run smoke          # just test/smoke.mjs (assumes dist/ is built)
node tools/probe.mjs   # raw NDJSON REPL against cbc, for checking protocol behaviour
```

The tests take the model from argv[2], then `CBC_TEST_MODEL`. The default `custom-local:cpa/gpt-6.1-terra` only exists on the original author's machine, so others must set their own. `CBC_TEST_MODEL_ALT` is the model the smoke test switches to. Run `cbc_models` (or `/probe-cbc`) to see what models are available. The tests use `ping -n`, which is Windows-only.

There is no unit-test suite. The smoke tests are the spec: they drive `dist/index.js` through a real MCP client against a real cbc.

## Layout

| File | Role |
|---|---|
| `src/cbc/locate.ts` | Finds cbc's **JS entry** (`CBC_ENTRY` → shim on PATH → `npm root -g`). |
| `src/cbc/process.ts` | `CbcProcess`: spawn `node <entry> ...`, NDJSON framing (StringDecoder for UTF-8), `control()` request/response pairing with ids `mcp_N`, `respond()`, kill whole tree. |
| `src/gate.ts` | Policy schema (zod), `DEFAULT_POLICY`, `evaluate()`. |
| `src/session.ts` | `Session`: one cbc process = one session. Turns, step ledger, pending decisions, event stream with seq cursor, `waitFor`, steer queue, per-turn overrides, rewind. Raw log to `%TEMP%/cbc-mcp/<iso>_<id>.jsonl`. |
| `src/index.ts` | `McpServer` with 16 `cbc_*` tools, session registry, env config, process cleanup on exit. |
| `test/*.mjs` | End-to-end smoke tests (plain JS, run against `dist/`). |
| `tools/probe.mjs` | Interactive raw protocol probe. |

## Design rules (keep these)

- **Never spawn `cbc.cmd` / use `shell: true`.** On Windows the shell mangles JSON arguments such as `--mcp-config`. Always spawn `process.execPath` with the JS entry. Kill with `taskkill /pid N /T /F` on Windows.
- **Always pass `--strict-mcp-config --mcp-config <json>`** (default `{"mcpServers":{}}`), or cbc inherits the user's global MCP servers (ssh, browser…).
- **Never allow `bypassPermissions` / `-y`.** `can_use_tool` only fires in `--permission-mode default`, and it is the whole Gate.
- **Never write the user's `~/.codebuddy/settings.json`.** Runtime changes go through `set_config` / `set_model` control requests, which are process-memory only.
- Sessions must keep **session persistence on** (no `--no-session-persistence`) and pass `--replay-user-messages`, otherwise rewind has no checkpoints / no user message uuid.
- `cbc_rewind` uses scope **Code only**. Conversation scope wipes the entire history in cbc 2.184.0. After a real rewind, a supervisor note is prepended to the next `cbc_send`.
- Long-poll caps: `wait_s` / `timeout_s` ≤ 50 because MCP clients time out requests at 60s.
- Gate semantics: rules top-down; first `allow`/`deny`/`escalate` wins; `rewrite` patches the input and **keeps evaluating**; fall-through → `default_action`. Escalations auto-resolve after `escalate_timeout_s` using `on_timeout`.
- `waitFor` wake rules (subtle — see the bug notes below): exited → return; decisions pending → return only on new events; `until:"event"` → new events; `until:"idle"` → status idle. `refreshStatus()` must run **before** pushing `turn_end`, and both call `notify()`.
- Steer is only accepted while the model is generating; during tool execution cbc answers `{steered:false, reason:"idle"}`. We queue it, retry 50ms after each `tool_result`, and fold any leftovers into the next send (`steer_deferred` event).
- Per-turn `model`/`effort` overrides on `cbc_send` are restored after `result`.

## Bugs already hit (don't reintroduce)

1. `cbc_wait` busy-looped while a decision was pending. Fix: only wake on `seq > cursor` while decisions are pending.
2. Waiters weren't woken at turn end, because `turn_end` was pushed before status became idle. Fix: `refreshStatus()` first, and it notifies.
3. Tool-time steers were silently lost. Fix: the steer queue.
4. A `wait_s` of 60 collided with the client's 60s timeout. Fix: cap at 50.
5. Some `result` messages have no `result` field (`error_during_execution`, "No response received from model"). Handle them tolerantly.

## Status / roadmap

MVP done and passing: gating (deny/rewrite/escalate/timeout), decide with reason, steer queue, interrupt, per-turn effort, set_model, rewind (dry-run + real), model listing.

Not done yet (from the original design):
- `cbc_fork` — spawn with `resume` + `fork_session` from an existing session.
- File-change ledger — diff per step/turn.
- Model routing policy — pick the model per turn by rule.
- Reverse channel — `sdkMcpServers` / `mcp_message`, so cbc can call tools Claude exposes. cbc sends `mcp_message`, `hook_callback` and `elicitation_create` requests; today we answer them with an error.

Unverified: whether `set_permission_mode` fully takes effect mid-turn.

## Housekeeping

Smoke runs leave:
- cbc session files in `~/.codebuddy/projects/` (clean up with `cbc cleanup`)
- temp workdirs `%TEMP%/cbc-mcp-{smoke,ctl,steer}-*`
- logs in `%TEMP%/cbc-mcp/`
