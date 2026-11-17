# cbc stream-json control protocol: measured behaviour

Everything here was measured against **CodeBuddy Code 2.184.0** on Windows 10 / Node 24 by driving the process directly. None of it comes from official docs. After a cbc upgrade, re-check it with `node tools/probe.mjs`.

## Launch

```
node <entry> -p --input-format stream-json --output-format stream-json
     --replay-user-messages --strict-mcp-config --mcp-config '{"mcpServers":{}}'
     --permission-mode default [--model M] [--max-turns N] ...
```

- `<entry>` = `<npm root -g>/@tencent-ai/codebuddy-code/bin/codebuddy` (a JS file). Do not go through `cbc.cmd`: the shell breaks JSON args.
- `--permission-prompt-tool` is **not** a valid option in this version.
- `--tools ""` does **not** remove tools. To restrict tools, use `--disallowedTools` or the Gate.
- Without `--strict-mcp-config`, cbc loads the user's global MCP servers.
- stdout is NDJSON. stdin takes NDJSON. Lines can contain Chinese paths, so decode with StringDecoder and never split on raw chunks.

## Messages out of cbc

| type / subtype | Notes |
|---|---|
| `system/init` | `session_id`, `model`, `permissionMode`, tools. |
| `system/usage_update`, `system/status` | Noise; ignore. |
| `assistant` | `message.content[]`: `text`, `thinking`, `tool_use{id,name,input}`; `message.model`. |
| `user` (no tool_result) | Echo of our user message, sent only with `--replay-user-messages`. Its `uuid` is the **rewind anchor**. |
| `user` (tool_result) | Tool output; `is_error` marks failures. |
| `result` | Turn end: `subtype`, `result` (**may be missing**), `duration_ms`, `modelUsage{model: tokens}`, `permission_denials`, `structured_output`. |
| `control_request` | cbc asks us something (see below). |
| `control_response` | Answer to one of our requests: `{response:{subtype:"success"\|"error", request_id, response\|error}}`. |

## Requests we send (`{type:"control_request", request_id, request:{subtype,...}}`)

| subtype | Payload → response | Verified behaviour |
|---|---|---|
| `initialize` | `{}` → capabilities | Send once at start. Passing `hooks` here registers them, but **`hook_callback` never fired** for PreToolUse in our tests, so the Gate uses `can_use_tool` instead. |
| `steer` | `{content_blocks:[{type:"text",text}]}` → `{steered:bool, reason?}` | Accepted only **while the model is generating**. During tool execution the response is `{steered:false, reason:"idle"}`. |
| `interrupt` | `{reason?}` | Ends the turn (a `result` arrives); the session stays usable. |
| `set_model` | `{model}` → `{model, previous_model}` | Takes effect on the next request; `assistant.message.model` confirms it. |
| `set_config` | `{config:{reasoningEffort:"low"\|"medium"\|"high"}}` → `{updated, errors}` | Process memory only; settings.json is byte-identical afterwards. Confirmed on gpt models through `reasoning_effort=` in `~/.codebuddy/logs/<date>/*.log`. On claude/* models it cannot be confirmed from logs. `thoughtLevel` is rejected because it is feature-flagged off. |
| `set_permission_mode` | `{mode}` | Returns success. Mid-turn effect not fully verified. |
| `get_available_models` | `{}` → `{availableModels:[{modelId,name,description}], rawModels}` | Works before any turn. |
| `rewind` | `{user_message_id, scope:"Code"\|"Conversation"\|"CodeAndConversation", dry_run?}` | See below. |

## Requests from cbc that we must answer

`{type:"control_request", request_id, request:{subtype:"can_use_tool", tool_name, input, tool_use_id, agent_id?, permission_suggestions?, blocked_path?, decision_reason?}}`

Reply with `{type:"control_response", response:{subtype:"success", request_id, response:{...}}}`. The inner response can be:
- `{allowed:true}` allows the call.
- `{allowed:true, updatedInput:{...}}` allows it with rewritten input. The tool runs with the new input.
- `{allowed:false, reason}` denies it. The model sees the reason and adapts; for example, "use v9 instead" leads it to write v9.
- `{allowed:false, reason, interrupt:true}` denies it and ends the turn.

Fires **only** in `--permission-mode default`. `bypassPermissions`/`-y` skips it entirely. In `acceptEdits`, edit tools skip it.

Other subtypes seen: `hook_callback`, `mcp_message`, `elicitation_create`. We currently answer them with `subtype:"error"`. `mcp_message` is the hook for a future reverse channel (`sdkMcpServers`).

`control_cancel_request {request_id}` means cbc no longer needs the answer.

## Rewind

- Needs **session persistence**. With `--no-session-persistence` every rewind fails with "No checkpoint".
- The anchor is the `uuid` of the replayed user message. `--replay-user-messages` is therefore required.
- `dry_run:true` returns the file list and leaves the disk untouched.
- **Code** scope restores files to their state before that user message. Files created after it are deleted. Works.
- **Conversation** scope (and the conversation half of CodeAndConversation) **wipes the whole history**, not just the part after the anchor. In our test, the model forgot codewords from turns before the anchor too. This is a cbc bug, so we never use it.
- Edits need a prior Read in the same session (cbc's read-before-write rule). Test prompts must read before editing.

## Persistence side effects

Session files accumulate in `~/.codebuddy/projects/<encoded cwd>/`. Clean them with `cbc cleanup`.
