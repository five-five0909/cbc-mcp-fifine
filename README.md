# cbc-mcp

让 Claude 把 CodeBuddy Code（`cbc`）当作**受监管的执行者**来驱动：cbc 每想调用一次工具，都要先过 Claude 定的闸门（Gate）。

基于 cbc 2.184.0 的 stream-json 双向控制协议（`can_use_tool` / `steer` / `interrupt` / `set_model` / `set_config` / `rewind`），所有能力都在本机实测过，实测细节见 [docs/cbc-protocol.md](docs/cbc-protocol.md)。开发约定见 [CLAUDE.md](CLAUDE.md)。

## 安装与注册

推荐从本仓库源码安装，再以 **stdio MCP server** 注册到 Claude Code。下面的步骤不会修改你的 CodeBuddy 全局配置，也不需要 GitHub Token（仓库是公有的）。

### 1. 准备环境

- **Node.js ≥ 20**，并能运行 `npm`。
- **Git**，用于克隆和更新源码。
- **CodeBuddy Code**，作为被调用的执行器；需要已登录或已配置可用的模型。
- **Claude Code**，作为 MCP 客户端；下面的注册命令需要 `claude` 已安装。

先检查命令是否可用：

```bash
node --version
npm --version
git --version
claude --version
```

如果还没有安装 CodeBuddy Code：

```bash
npm install -g @tencent-ai/codebuddy-code
cbc --version
cbc
```

首次运行 `cbc` 时，按终端提示完成登录或模型配置，确认能正常使用后退出。项目原有协议测试基于 **cbc 2.184.0**，其他版本的兼容性需要另行验证。

> Windows 和 WSL 请分别视为独立环境。若在 WSL 运行 Claude Code，请在同一个 WSL 环境安装 Node.js、依赖和 CodeBuddy，并使用 `/home/...`、`/mnt/c/...` 等 Linux 路径，不要直接填 `C:\...`。

### 2. 克隆源码并构建

在你准备存放项目的目录执行（Bash、zsh 或 PowerShell 均可逐行运行）：

```bash
git clone https://github.com/five-five0909/cbc-mcp-fifine.git
cd cbc-mcp-fifine
npm ci
npm run build
```

构建后入口是 `dist/index.js`。`npm ci` 会根据锁文件安装依赖；构建需要 TypeScript 开发依赖，因此不要加 `--omit=dev`。`dist/` 和 `node_modules/` 不在 Git 仓库中，克隆后必须安装并构建。

在项目根目录执行以下命令，获取注册时要用的**入口绝对路径**：

```bash
node -p "require('node:path').resolve('dist/index.js')"
```

### 3. 注册到 Claude Code

将下面引号中的路径替换成上一步输出的真实路径。注册后需要保留这个项目目录，因为 Claude Code 会从这里启动服务。

Linux / macOS / WSL 示例：

```bash
claude mcp add --transport stdio --scope user cbc -- node "/absolute/path/cbc-mcp-fifine/dist/index.js"
```

Windows PowerShell 示例：

```powershell
claude mcp add --transport stdio --scope user cbc -- node "C:\path\cbc-mcp-fifine\dist\index.js"
```

`--scope user` 表示当前用户的所有项目都可使用。若只想在某个工作项目使用，先进入那个项目，再把它改成 `--scope local`。

如使用其他支持 stdio 的 MCP 客户端，可在该客户端的 MCP 配置中合并以下内容，路径同样要替换：

```json
{
  "mcpServers": {
    "cbc": {
      "command": "node",
      "args": ["/absolute/path/cbc-mcp-fifine/dist/index.js"]
    }
  }
}
```

Windows 的 JSON 路径可写成 `C:/path/cbc-mcp-fifine/dist/index.js`。若客户端找不到 `node`，将 `command` 改为 Node.js 可执行文件的绝对路径。

### 4. 验证连接

```bash
claude mcp get cbc
```

重新启动 Claude Code 会话后，让它「调用 `cbc_list` 查看当前会话」。新启动的服务没有会话是正常的；能列出会话说明 MCP 连接可用，但尚未验证 CodeBuddy 的登录和模型调用。

要验证完整链路，可再让 Claude 在你指定的**现有工作目录绝对路径**调用 `cbc_start`，只回复一句话、不读写文件；根据需要传入你自己的模型 ID，再用 `cbc_wait` 取结果、`cbc_stop` 结束会话。**这一步会真实调用模型，可能产生费用。**

### 可选环境变量

注册时可用 `-e KEY=VALUE` 配置环境变量，放在 `--` 之前。例如，限制可用工作目录：

```bash
claude mcp add --transport stdio --scope user -e "CBC_MCP_ALLOWED_ROOTS=/home/me/work" cbc -- node "/absolute/path/cbc-mcp-fifine/dist/index.js"
```

| 变量 | 作用 |
|---|---|
| `CBC_MCP_ALLOWED_ROOTS` | 允许作为会话 `cwd` 的根目录；多个目录在 Windows 用 `;` 分隔，Linux / macOS / WSL 用 `:` 分隔。不设则不限制。它限制可选工作目录，不是文件访问沙箱 |
| `CBC_MCP_MAX_SESSIONS` | 同时存活的 cbc 会话上限，默认 4 |
| `CBC_ENTRY` | 自动查找失败时，手动指定 CodeBuddy 的 JS 入口 `.../@tencent-ai/codebuddy-code/bin/codebuddy`，不要填 `cbc.cmd` |

### 更新与常见问题

更新时在本仓库根目录执行，再重启使用它的 MCP 客户端：

```bash
git pull --ff-only
npm ci
npm run build
```

- **找不到 `dist/index.js`**：确认已经运行 `npm run build`，且注册的是绝对路径。
- **`tsc: Permission denied`**：可用 `node node_modules/typescript/bin/tsc -p .` 直接运行编译器；若依赖是从另一系统复制来的，建议在当前环境重新执行 `npm ci`。
- **`Could not find the CodeBuddy Code entry`**：确认 CodeBuddy 安装在 MCP 客户端使用的同一环境。可运行 `npm root -g`，检查该目录下的 `@tencent-ai/codebuddy-code/bin/codebuddy`，然后用 `CBC_ENTRY` 显式指定。
- **已连接但模型调用失败**：在同一环境单独运行 `cbc`，检查登录状态和模型配置；不要照抄测试里的自定义模型 ID。
- **`cwd is outside CBC_MCP_ALLOWED_ROOTS`**：使用允许根目录内的工作目录，或调整注册时的环境变量。
- **手动运行 `node dist/index.js` 后没有提示**：服务通过 stdin/stdout 等待 MCP 消息，不是交互式聊天程序；请通过 MCP 客户端验证。

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
