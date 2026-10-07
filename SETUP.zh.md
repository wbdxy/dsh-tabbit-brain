# 安装与验收

## 前置条件

需要 Windows、Node.js 22.19+、DSH，以及已安装并登录的 Tabbit。账号注册和登录由用户完成。

## 1. 部署网关

先按 [`REVERSE-PROXY.zh.md`](REVERSE-PROXY.zh.md) 理解反代协议，再部署网关：

```powershell
node gateway-patch/install.mjs --dry-run
node gateway-patch/install.mjs --api-key <YOUR_KEY> --base-url https://web.tabbit.com
```

`<YOUR_KEY>` 是你在网关 `.env` 中设置的 `API_KEY`，也要作为 DSH 的 `TABBIT_API_KEY`。国际版使用 `https://web.tabbit.ai`。安装器会从上游取得网关并覆盖我们的改动；上游没有 LICENSE，公开再分发许可仍需确认。

验证网关：

```powershell
Invoke-RestMethod 'http://127.0.0.1:8787/healthz' -Headers @{Authorization="Bearer <YOUR_KEY>"}
Invoke-RestMethod 'http://127.0.0.1:8787/v1/models' -Headers @{Authorization="Bearer <YOUR_KEY>"}
```

## 2. 安装插件

```powershell
git clone https://github.com/wbdxy/dsh-tabbit-brain.git
cd dsh-tabbit-brain
npm install --ignore-scripts --legacy-peer-deps
dsh plugin --profile <PROFILE> add link:<ABSOLUTE_PLUGIN_DIR>
```

把 `<PROFILE>` 换成实际 DSH profile；`<ABSOLUTE_PLUGIN_DIR>` 换成本插件绝对路径。插件为普通主代理和拥有自己 owner 的普通子代理注册 README 中列出的七个 Brain 工具，不需要子代理预设或手工添加 `tool-subagent-tabbit`。

## 3. 配置模型和凭据

设置用户环境变量，值必须等于网关 `.env` 的 `API_KEY`：

```powershell
$key = Read-Host 'Gateway API key' -AsSecureString
$plain = [System.Net.NetworkCredential]::new('', $key).Password
[Environment]::SetEnvironmentVariable('TABBIT_API_KEY', $plain, 'User')
$env:TABBIT_API_KEY = $plain
Remove-Variable plain, key
```

在插件设置中确认：`agentModel` 是 `/v1/models` 返回的实际模型 id，`gatewayUrl`、`apiKeyEnv` 和网关一致。用户也可以把 `/v1/models` 返回的任意模型 id 传给 `tabbit_brain` 的 `model` 参数，仅覆盖单次请求，不改变全局设置。`delegationStyle` 可选 `off`、`standard`（默认）或 `aggressive`。

## 4. 重启并验收

重启 DSH，打开普通主对话，检查工具列表中存在 `tabbit_brain`。渐进式预设先按其正常流程调用 `phase_begin`；不要调用 `phase_advance` 伪造阶段完成。

调用示例：

```text
请把下面这段纯推理任务交给 tabbit_brain，使用 run_in_background: true。发起后继续做自己的工具工作，收到 job_output 后核验结果。
```

验收要求：

- 返回 job ID，不是 DSH 子 agent ID。
- Brain 调用不创建 DSH 子会话，历史由插件按调用者 owner 和 `conversation` 标签隔离。
- 网关收到 `/v1/chat/completions` 请求，返回 receipt 中的 model 与 endpoint。
- 请求不包含 `tools` 或 `tool_choice`。
- 同一 `conversation` 串行，不同标签独立。

## 5. 能力边界与 DSH Skill 转交

这个插件是文字转交层，不是第二个 DSH 工具运行器。主 DSH 代理能看到本机 Skill 目录、文件、附件、浏览器操作工具和验证工具；Brain 只收到 `prompt` 中的文字，以及自己会话保留的历史。需要 DSH 专有 Skill 时，先由主代理执行，再把结果或忠实提取的文字转录交给 Brain：

```text
主代理已执行 DSH Skill <SKILL_NAME>。以下是相关完整结果：
<粘贴结果或提取的证据>
现在请基于这些内容分析/设计/总结。不要声称自己执行过该 Skill 或读取过原始文件。
```

不要只传本机路径来代替文件内容。当前 `tabbit_brain` 不能打开本机路径、读取 DSH Skill 目录、使用 `tabbit_browser`，也没有通用文件附件参数。

反代 Tabbit 服务另有已经实测的上游搜索/网页抓取、Tabbit 自身 Skill/妙招资料检索、多模态读图和 HTML/SVG Widget 生成能力。搜索与抓取受站点限制，事实仍需核验。Tabbit Skill 资料来自 Tabbit 自己的帮助/Skill 源，不是本机 DSH 目录。上游浏览器任务事件和 `agent_mode` 可以被转发，但当前桥接尚未产生可验证的浏览器状态回执，不要声称它能控制用户的 Tabbit 浏览器。`browser_control` 指令可能只作为文字返回而未执行。Widget HTML 可由网关保存；DSH 内嵌渲染尚未形成已验收契约。通用文件附件仍未接通。

## 5. Cookie 恢复边界

Tabbit 没开：网关会启动短命 headless 读取已有登录态，取完退出。普通 Tabbit 已开但无 CDP：本次读取跳过并沿用旧 cookie。若服务端 token 已失效，先重新登录、保存工作并完全退出 Tabbit，再显式刷新：

```powershell
Invoke-RestMethod 'http://127.0.0.1:8787/admin/refresh-cookie' -Method Post -Headers @{Authorization="Bearer $env:TABBIT_API_KEY"}
```

## 6. 远端绑定与恢复

Brain 发送 `X-Brain-Conversation-Id`，将本地会话绑定到长期使用、创建时为空的远端会话。源码契约通过 `POST /panel/session` 创建，再用 `GET /panel/id/data` 校验：返回 ID 须匹配，历史须为空。

网关账本 `state/brain-session-map.json` 按 `accountKey` 和 `baseURL` 划分 scope。为目标账号显式设置 `TABBIT_ACCOUNT_KEY`；更换账号或后端环境时将 `TABBIT_BRAIN_SESSION_MAP_PATH` 设为独立账本路径。账本的 `baseURL` scope 字段不是插件的 `gatewayUrl`。provenance 为 `created`、`pool`、`legacy` 或 `unverified`；已有非 `created` 绑定以 409 fail closed。旧 scope 或 provenance 应为目标账号/环境显式选择新的 state 路径。保留原 state 和 history，不用删除它们代替恢复。

生产 Brain create 失败直接暴露错误，不 fallback 到池会话。Brain pool 相关的 409 兼容仅用于显式选择的兼容 fixture。独立 legacy mode 保留可运行的列表池路径，并非仅限 fixture。本地 SQLite 持久化不证明生产隔离或远端隐藏账号记忆不存在。

## 7. 回归测试

```powershell
npm run test:brain
python tools/test-setup.py
npm run check
npm run scan
npm run audit:docs
```

Task4 源码检查（83 项测试）与独立 review 已通过。本机部署也已完成默认端口网关、重启映射、新主对话冒烟、A/B 隔离、后台任务和分页验收。能力验收另行分层：搜索/网页抓取、读图、Tabbit 自有 Skill 资料检索和网关 Widget 捕获已验证；浏览器任务执行、`browser_control` 执行、DSH 内嵌 Widget 渲染和通用文件附件不作为已完成能力。证据与范围见 `D:/my-project/tabbit-capabilities-4efc/EXTENDED-CAPABILITIES.md`。
