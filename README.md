# cbc-mcp

让 Claude 把 CodeBuddy Code（`cbc`）当作**受监管的执行者**来驱动：cbc 每想调用一次工具，都要先过 Claude 定的闸门（Gate）。

基于 cbc 2.184.0 的 stream-json 双向控制协议（`can_use_tool` / `steer` / `interrupt` / `set_model` / `set_config` / `rewind`），所有能力都在本机实测过，实测细节见 [docs/cbc-protocol.md](docs/cbc-protocol.md)。开发约定见 [CLAUDE.md](CLAUDE.md)。

## 安装与注册

```bash
npm install
npm run build
claude mcp add cbc -- node <项目绝对路径>/dist/index.js
```

可选环境变量（加在 `claude mcp add` 里，用 `-e KEY=VALUE`）：

| 变量 | 作用 |
|---|---|
| `CBC_MCP_ALLOWED_ROOTS` | 允许作为 cwd 的根目录，多个用 `;` 分隔（Windows）。不设则不限制 |
| `CBC_MCP_MAX_SESSIONS` | 同时存活的 cbc 会话上限，默认 4 |
| `CBC_ENTRY` | 手动指定 `.../@tencent-ai/codebuddy-code/bin/codebuddy`（自动查找失败时用） |

## 典型流程

```
cbc_start {cwd, model, policy, prompt}      → session_id
loop:
  cbc_wait {session_id, cursor}             → events + pending_decisions + status
  如果 pending_decisions 非空 → cbc 正卡在这次工具调用上
    cbc_decide {decision_id, allow|deny, reason?, updated_input?}
  直到 status = idle
cbc_steps / cbc_step / cbc_turns            → 审查它干了什么
cbc_send {text, model?, effort?}            → 下一轮（可单轮覆盖模型/强度）
cbc_stop
```

## 工具一览（16 个）

| 平面 | 工具 | 说明 |
|---|---|---|
| 输入 | `cbc_start` | 启动会话；可带首条 prompt、模型、effort、gate policy、max_turns、turn_timeout_s、子 agent、json_schema、resume/fork |
| | `cbc_send` | 开新一轮；`model` / `effort` 只作用于本轮，结束后自动还原 |
| | `cbc_steer` | 运行中插话。cbc 只在模型生成时接收；工具执行中会排队，工具返回后立即送达；本轮已结束则并入下一次 `cbc_send` |
| 控制 | `cbc_decide` | 回答被上报的工具调用：放行 / 改参数放行 / 拒绝并给理由 / 拒绝并打断 |
| | `cbc_set` | 运行时改模型、effort、权限模式、整套 policy 或前插规则 |
| | `cbc_interrupt` | 打断当前轮，会话保留 |
| | `cbc_rewind` | 把磁盘文件回滚到第 N 轮开始前（先 dry_run） |
| | `cbc_stop` | 结束进程（优雅退出 → 杀进程树） |
| 观测 | `cbc_wait` | 长轮询（≤50s），返回增量事件、待决请求、提示下一步 |
| | `cbc_events` | 分页读事件流，可按 kind 过滤 |
| | `cbc_steps` | 工具调用台账：工具、摘要、闸门判决（规则号/由谁决定）、状态、结果预览 |
| | `cbc_step` | 单步完整输入（含改写后的输入）与完整输出 |
| | `cbc_turns` | 每轮：结果、耗时、按模型拆分的 token、permission_denials、结构化输出 |
| | `cbc_policy` / `cbc_list` / `cbc_models` | 当前策略 / 会话列表 / 可用模型 |

## Gate 策略

规则从上到下匹配：第一个 `allow` / `deny` / `escalate` 生效；`rewrite` 改写参数后**继续往下匹配**（改写后的调用仍受后续规则约束）。

```jsonc
{
  "rules": [
    {"match": {"tool": "Read|Glob|Grep"}, "action": "allow"},
    {"match": {"tool": "Edit|Write", "path_outside": ["${cwd}"]}, "action": "deny", "reason": "只能改工作区"},
    {"match": {"tool": "Bash", "input": {"command": "^(git push|rm -rf|curl)"}}, "action": "escalate"},
    {"match": {"tool": "Bash", "input": {"command": "^npm install"}}, "action": "rewrite",
     "patch": {"command": "npm install --ignore-scripts"}},
    {"match": {"tool": "Bash"}, "action": "allow"}
  ],
  "default_action": "escalate",     // 没匹配上的交给 Claude
  "escalate_timeout_s": 300,        // Claude 多久不答就按 on_timeout 处理
  "on_timeout": "deny"
}
```

- `tool`：对工具名做整串正则匹配。
- `input`：对 `tool_input` 的字段做正则搜索，所有字段都要匹配。
- `path_outside`：`file_path` / `path` / `notebook_path` 落在所有给定根目录之外时匹配。

默认策略：cwd 内的只读工具放行，cwd 外的只读和其它一切都上报。

## 安全默认值

- **不继承你的全局 MCP**：始终 `--strict-mcp-config`，默认 `{"mcpServers":{}}`。否则 cbc 会连上你配的 ssh、浏览器等 server。
- **不允许 `-y` / `bypassPermissions`**：那会绕过整个 Gate。`acceptEdits` 允许使用，但编辑类调用由 cbc 自己放行，不经过 Gate。
- `set_config` 只改 cbc 进程内存，**不会写** `~/.codebuddy/settings.json`（已逐字节比对验证）。
- 直接用 `node` 启动 cbc 的 JS 入口，不经过 `cbc.cmd`（经过 shell 会把 JSON 参数拆碎）；停止时用 `taskkill /T /F` 杀整棵进程树。

## 已知限制（cbc 2.184.0）

- **对话回滚不可用**：`rewind` 的 Conversation 范围会清空整段历史（持久化也一样），所以 `cbc_rewind` 只回滚文件，并在下一次 `cbc_send` 自动告诉 cbc「这些改动已撤销，请重新读取文件」。
- **`rewind` 依赖会话持久化**：所以会话不加 `--no-session-persistence`，会话文件会留在 `~/.codebuddy/projects/`，用 `cbc cleanup` 清理。
- **effort**：在 gpt 系模型上已通过请求日志确认生效；在 claude/* 模型上效果无法从日志确认。`thoughtLevel` 在这个版本被功能开关关掉了。
- `--tools ""` 不会真的移除工具，限制工具请用 Gate 或 `disallowed_tools`。
- 如果 cbc 不经权限检查就自行放行某个调用，这个调用不会经过 Gate，台账里记作 `allow/auto`。目前测试里还没遇到这种情况，遇到时可以在 `cbc_steps` 里看到。

## 测试

需要 cbc 已登录，会真实调用模型（每次总共约 1 分钟）。默认测试模型是原作者机器上的自定义模型，请换成你自己的（可用 `cbc_models` 查）：

```bash
CBC_TEST_MODEL=<模型id> CBC_TEST_MODEL_ALT=<切换用的另一个模型id> npm test
```

测试里用了 `ping -n`，目前只能在 Windows 上跑。

- `test/smoke.mjs`：策略的 deny / rewrite / escalate、按拒绝理由调整、单轮 effort、rewind dry_run 和真实回滚、切模型、停止
- `test/smoke-control.mjs`：上报超时自动拒绝、steer 排队、interrupt 后会话仍可用
- `test/smoke-steer.mjs`：工具执行中发出的 steer 在同一轮内送达

每个会话的原始 cbc 输出都记在 `%TEMP%/cbc-mcp/*.jsonl`（路径见 `cbc_list` 的 `log_path`）。

## 协议探针

`node tools/probe.mjs [--model M] [--cwd DIR] [--persist] [--ask]` 会直接启动 cbc，用 NDJSON 手动对话：输入普通文本发送用户消息，`/ctl <subtype> {json}` 发送控制请求，加 `--ask` 后用 `/allow`、`/deny 理由` 手动裁决每个工具调用。升级 cbc 后可以用它（或 Claude Code 里的 `/probe-cbc`）重新核对协议。
