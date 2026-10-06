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

把 `<PROFILE>` 换成实际 DSH profile；`<ABSOLUTE_PLUGIN_DIR>` 换成本插件绝对路径。插件会给普通主 agent 自动注册 `tabbit_brain` 和 `tabbit_brain_reset`，不需要创建子 agent 预设，也不需要在主预设中手工添加旧的 `tool-subagent-tabbit`。

## 3. 配置模型和凭据

设置用户环境变量，值必须等于网关 `.env` 的 `API_KEY`：

```powershell
$key = Read-Host 'Gateway API key' -AsSecureString
$plain = [System.Net.NetworkCredential]::new('', $key).Password
[Environment]::SetEnvironmentVariable('TABBIT_API_KEY', $plain, 'User')
$env:TABBIT_API_KEY = $plain
Remove-Variable plain, key
```

在插件设置中确认：`agentModel` 是 `/v1/models` 返回的实际模型 id，`gatewayUrl`、`apiKeyEnv` 和网关一致。`delegationStyle` 可选 `off`、`standard`（默认）或 `aggressive`。

## 4. 重启并验收

重启 DSH，打开普通主对话，检查工具列表中存在 `tabbit_brain`。渐进式预设先按其正常流程调用 `phase_begin`；不要调用 `phase_advance` 伪造阶段完成。

调用示例：

```text
请把下面这段纯推理任务交给 tabbit_brain，使用 run_in_background: true。发起后继续做自己的工具工作，收到 job_output 后核验结果。
```

验收要求：

- 返回 job ID，不是 DSH 子 agent ID。
- 不创建 DSH 子会话，历史由插件按主会话和 `conversation` 标签隔离。
- 网关收到 `/v1/chat/completions` 请求，返回 receipt 中的 model 与 endpoint。
- 请求不包含 `tools` 或 `tool_choice`。
- 同一 `conversation` 串行，不同标签独立。

## 5. Cookie 恢复边界

Tabbit 没开：网关会启动短命 headless 读取已有登录态，取完退出。普通 Tabbit 已开但无 CDP：本次读取跳过并沿用旧 cookie。若服务端 token 已失效，先重新登录、保存工作并完全退出 Tabbit，再显式刷新：

```powershell
Invoke-RestMethod 'http://127.0.0.1:8787/admin/refresh-cookie' -Method Post -Headers @{Authorization="Bearer $env:TABBIT_API_KEY"}
```

## 6. 回归测试

```powershell
npm run test:brain
python tools/test-setup.py
npm run check
npm run scan
npm run audit:docs
```

当前实现已通过本地 fixture；新 DSH 会话和真实网关请求仍需按上面的验收要求确认。远程 Tabbit 会话是否完全隔离，不由本地历史隔离自动证明。
