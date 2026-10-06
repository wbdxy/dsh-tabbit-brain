# 安装与配置

[English](SETUP.md) | **简体中文**

这份文档回答一个问题：**在一台新电脑上，从零到能用，我要做哪些事？**

---

## 步骤 0：先理解反代（**建议先读**）

整个项目建立在一件事上：**把 Tabbit 的 AI 后端翻译成 OpenAI 兼容 API**。
后面所有步骤（装网关、注册 provider、建预设）都只是在为这件事铺路。

所以先读 [`REVERSE-PROXY.zh.md`](REVERSE-PROXY.zh.md)。它讲清楚：

- 认证为什么需要**两条腿**（会话 cookie + 签名 key），以及 cookie 为什么只能从浏览器拿
- 请求头怎么签，以及**两个头名字与内容反直觉**的那个坑
- 聊天报文的字段结构，以及**为什么必须有已存在的会话**
- 输入长度上限（约 20500）与它导致的真实故障——**这正是本插件"独立预设"设计的由来**
- 图片为什么"能看懂内容"却"拿不到像素"
- 已知的不完美之处（含错误码 492 的误判）

**不读这份文档也能装起来，但出了问题只能猜。** 反代的每一处细节都在里面。

---

## 一页总览

| 步骤 | 谁做 | 能做吗 |
|---|---|---|
| **先读反代原理** | **你** | 建议。不知道原理也能装，出问题只能猜 |
| **安装 Tabbit 浏览器并登录账号** | **你** | ⚠️ **必须——没有它一切免谈** |
| 安装 Node.js 22+、DSH | 你 | 必须 |
| 部署网关（clone 上游 + 覆盖我们的改动） | 你 | **一条命令**（installer 全自动） |
| 安装本插件 | 你 | 一条命令 |
| 注册 provider 到 `settings.yaml` | 你 | 复制粘贴 |
| 创建子代理预设 | 你 | 复制粘贴 |
| 在主预设里挂载委派工具 | 你 | 复制粘贴 |
| — | — | — |
| 网关按需拉起 | **自动** | 插件负责 |
| 浏览器路径探测 | **自动** | 网关负责 |
| cookie 续期（短命 headless） | **自动** | 网关负责 |
| 委派指引注入系统提示词 | **自动** | 插件负责 |

> **先看这里**：如果你的 Tabbit 没登录，后面全部白做。第 1 步是硬前提。

---

## 前置条件

### 1. Tabbit 浏览器 + 已登录的账号 ← 最重要

Cookie 续期的原理是：**从你自己的浏览器里读出登录会话**。所以：

- 必须安装 Tabbit 浏览器
- 必须**注册并登录**一个 Tabbit 账号
- 官方提供**免费账号**，不登录拿不到任何 cookie，整条链路都不会工作

验证方法——打开 Tabbit，确认已登录，然后确认 user-data 目录存在：

```powershell
Test-Path "$env:LOCALAPPDATA\Tabbit Browser\User Data"
# 期望：True
```

> 免费账号够用吗？够。模型可用范围取决于你的账号套餐与所在地区；本插件不假设具体模型名。

### 2. Node.js 22+

```powershell
node --version    # 需要 v22.19+ 或 v24+
```

### 3. DSH

已安装并能正常启动即可。

---

## 步骤 1：部署网关

**先说清楚归谁**：网关**不是**本插件的一部分，它是 `goehou/tabbit-toy` 的一个分支。
本插件只负责"保证网关在跑"。

### 为什么是"安装器"而不是"独立仓库"

我们**没有**把网关单独发一个仓库。**这是刻意的**，原因是许可证：

```
goehou/tabbit-toy  →  GitHub API 返回 "Not Found"（无 LICENSE 文件）
```

**未声明许可 = 默认保留所有权利。** 发布一份它的完整副本法律上站不住。

所以我们的做法是：**装的时候在你机器上从官方仓库取，再覆盖我们改动的文件。**
我们只分发自己写的那部分。

顺带的好处：**上游更新能自然流入**——重跑脚本就拿到上游最新代码 + 我们的改动。

### 一条命令（推荐）

```bash
node gateway-patch/install.mjs --dry-run     # 先看会做什么，不写任何文件
node gateway-patch/install.mjs               # 真正执行
```

**必须你自己填的（★）**：

| 参数 | 说明 | 默认 |
|---|---|---|
| ★ `--api-key <key>` | 网关鉴权 key。**DSH 那侧的 `TABBIT_API_KEY` 必须与它一致** | `sk-tabbit-local` |
| ★ `--base-url <url>` | **国内版 `https://web.tabbit.com`，国际版 `https://web.tabbit.ai`** | 国内版 |

其余参数（`--dir` / `--port` / `--repo` / `--ref`）都有合理默认值，一般不用管。
`node gateway-patch/install.mjs --help` 有完整列表。

它做四件事：clone 上游 → 覆盖我们的 4 个改动文件 → 写 `.env` → 提示下一步。
全程幂等：已存在的目录会先备份（`*.upstream-bak`），不会盲目覆盖。

### 它覆盖了哪 4 个文件

| 文件 | 性质 | 作用 |
|---|---|---|
| `scripts/lib/detect.mjs` | **原创新增** | 浏览器位置/profile 自动探测 |
| `scripts/lib/cdp.mjs` | 修改 | 短命 headless 取 cookie |
| `src/config.mjs` | 修改 | 路径走自动探测 |
| `src/server.mjs` | 修改 | cookie 刷新两段式 |

为什么改这些、以及背后的实测数据，见 [`gateway-patch/README.md`](gateway-patch/README.md)。

### 手工方式（想自己控制时）

```powershell
# 1. 取源码
git clone https://github.com/goehou/tabbit-toy
cd tabbit-toy
npm install

# 2. 把本项目 gateway-patch/files/ 下的 4 个文件复制进去
#    （目录结构一一对应）

# 3. 写 .env
```

```ini
TABBIT_BASE_URL=https://web.tabbit.com     # 国际版改成 https://web.tabbit.ai
PORT=8787
API_KEY=sk-tabbit-local                    # 自己定，后面两处要一致
CDP_PORT=9222
COOKIE_REFRESH_MINUTES=360

TABBIT_AUTO_LAUNCH_BROWSER=1
# 下面两项留空即可 —— 会自动探测
# TABBIT_EXE=
# TABBIT_USER_DATA_DIR=
```

### 验证

```powershell
cd <网关目录>
npm install          # 如果安装器提示缺依赖
node src/server.mjs
```

看到这段就成功了：

```
[server] cookie 自动刷新失败: fetch failed；改用短命 headless 实例取 cookie…
[server] [headless] 启动短命 headless 实例取 cookie（端口 9222）
[server] [headless] 已结束短命 headless 实例
[server] cookie 已自动刷新 (5 个, 长度 1370) [ephemeral]
```

**`[ephemeral]` = 它无窗口地起了一个浏览器实例、拿到 cookie、立刻杀掉。**

> 如果日志说 `cookie 里没有 token` —— 说明你的 Tabbit 没登录。回到前置条件第 1 步。

---

## 步骤 2：安装插件

```bash
dsh plugin --profile <你的profile> add dsh-tabbit-brain
```

> 本地目录安装：`dsh plugin --profile <profile> add link:/path/to/dsh-tabbit-brain`

---

## 一键助手：先预览，再执行

在插件目录运行；先安装包依赖。`--models` 必填，使用网关 `/v1/models` 返回的实际 id。
把 `<MAIN_PRESET>` 换成已有主对话预设 id，把 `<MODEL_IDS>` 换成逗号分隔的模型 id。
`DSH_HOME` 环境变量可覆盖默认的 `~/.dsh`。

```powershell
npm install --ignore-scripts --legacy-peer-deps
node scripts/setup.mjs --help
node scripts/setup.mjs --models "<MODEL_IDS>" --mount-preset "<MAIN_PRESET>" --write-settings --dry-run
node scripts/setup.mjs --models "<MODEL_IDS>" --mount-preset "<MAIN_PRESET>" --write-settings
```

| 参数 | 作用与省略行为 |
|---|---|
| `--models <id,id>` | 必填；缺失时退出，不自动读取模型列表 |
| `--mount-preset <id>` | 已有主预设；省略则读 `agent-presets.default`，缺失或文件不存在时退出 |
| `--api-key <key>` | 与网关 `API_KEY` 一致；默认 `sk-tabbit-local`。命令行参数可能出现在本机进程列表和 shell 历史中 |
| `--base-url <url>` | LLM 接口地址；默认 `http://127.0.0.1:8787/v1` |
| `--provider <name>` | LLM 路由名，默认 `tabbit-local`；不是子代理 provider 名 `tabbit` |
| `--preset-id <id>` | 子预设目录名，默认 `tabbit-brain`；自定义时也要修改插件的 `presetId` |
| `--profile <name>` | 用于检查 profile 是否存在；脚本本身不安装插件 |
| `--dry-run` | 预览所有写入；不创建文件、目录或备份 |
| `--write-settings` | 允许写 settings；省略它仍会创建子预设并修改主预设，只有 `--dry-run` 才是完全只读 |
| `--force` | 覆盖目标 LLM provider 和子预设；主预设已存在的工具行仍保留 |

脚本先解析 settings 和主预设 YAML，再进行写入。损坏 YAML 或错误类型会在写入前退出。
写入前备份已有文件；配置值会保留，但 settings 的注释与排版可能变化。
多文件写入不是事务：权限或磁盘故障时可能只有部分文件写入，需检查输出及 `.bak-setup-*`。

## 步骤 3：注册 provider

上面的执行命令写入 `llm-pi-ai.providers.tabbit-local`。它和子代理 provider `tabbit`
是两个不同名称。自定义 `--provider` 后，还要在插件设置中把 `agentProvider` 改成同一值。
将 `agentModel` 设为 `/v1/models` 返回的实际模型 id。

在 PowerShell 中保存网关 API key，避免把它直接粘贴进命令历史：

```powershell
$key = Read-Host 'Gateway API key' -AsSecureString
$plain = [System.Net.NetworkCredential]::new('', $key).Password
[Environment]::SetEnvironmentVariable('TABBIT_API_KEY', $plain, 'User')
$env:TABBIT_API_KEY = $plain
Remove-Variable plain, key
```

这个值必须与网关 `.env` 的 `API_KEY` 相同。重启 DSH 后进程才会继承新用户环境变量。

## 步骤 4：创建子代理预设

执行助手同时创建 `preset.yml` 和 `agent.cordis.yml`。
已有子预设默认保留；模板的 `complete: true` 与无工具配置见
[README 配套预设](README.zh.md#配套预设)。预设可以作为模板随包分发，
但本插件当前要求助手把模板写入用户目录，或由用户手工创建。

## 步骤 5：挂载委派工具

执行助手向已有主预设的 YAML 序列追加 `tool-subagent-tabbit`；存在同 id 时保留。
工具配置固定为 `provider: tabbit`、`toolName: subagent_tabbit`、`backgroundMode: continuable`。
插件 `providerName` 应保持 `tabbit`；改名时需手工同步该工具行。
脚本不会把工具插入已有的嵌套 delegation 分组。

## 步骤 6：验证

```powershell
$env:TABBIT_API_KEY = [Environment]::GetEnvironmentVariable('TABBIT_API_KEY', 'User')
Invoke-RestMethod 'http://127.0.0.1:8787/healthz' -Headers @{Authorization="Bearer $env:TABBIT_API_KEY"}
Invoke-RestMethod 'http://127.0.0.1:8787/v1/models' -Headers @{Authorization="Bearer $env:TABBIT_API_KEY"}
```

网关健康请求应返回 `ok: true`，模型列表应包含 `agentModel`。
然后重启 DSH，在主对话请求一次实际委派，确认有模型回答，且子会话记录目标预设。
诊断关闭时没有 `trace.log` 是正常现象，不能据此判定插件未加载。
安装助手的隔离回归测试需要 Python 和 PyYAML：

```powershell
python -m pip install PyYAML
python tools/test-setup.py
```

---

## cookie 续期：你唯一需要动手的场景

**这是使用中最容易困惑的一点。**

续期**不只在 cookie 过期时发生**，它是**定期**的（网关启动时、每 6 小时、遇到鉴权错误时）。

| 那一刻的状态 | 结果 |
|---|---|
| **Tabbit 没开且已有有效登录态** | 网关尝试短命 headless 读取，再清理实例 |
| **Tabbit 开着、用调试端口启动的** | ✅ 直接从它读，你无感 |
| **Tabbit 开着、普通方式启动的** | ⚠️ **跳过这次续期**，沿用已有 cookie |

### 恢复方法与边界

读取 cookie 不是账号注册或重新登录，也不保证服务端恢复已失效的 token。
Tabbit 没开、路径正确、profile 已登录时可以尝试自动读取；缺少登录态、端口冲突等也会失败。
普通 Tabbit 正在运行且没有 CDP 时，本次读取跳过，旧 cookie 仍有效则继续调用。
若鉴权失败：先在 Tabbit 重新登录（如需要），保存工作并完全退出，然后重试委派；
也可以明确触发读取，避免等待定时周期：

```powershell
Invoke-RestMethod 'http://127.0.0.1:8787/admin/refresh-cookie' -Method Post -Headers @{Authorization="Bearer $env:TABBIT_API_KEY"}
```

当前管理端点在读取失败后也可能返回沿用旧 cookie 的 `ok: true`；应核对
`lastCookieRefresh` 是否更新并重试模型请求。不要仅用 `ok` 判断登录态有效。
清理当前使用启动前后 PID 差集，已验证启动前存在的用户窗口被保留；
用户在 headless 读取期间新开实例的竞态仍未充分验证。读取期间先不要手动启动 Tabbit。

---

## 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `cookie 里没有 token` | **Tabbit 未登录** | 打开 Tabbit 登录一次 |
| `拿不到 cookie` | user-data 目录探测失败 | 在网关 `.env` 里显式填 `TABBIT_USER_DATA_DIR` |
| `未配置 Tabbit 可执行文件路径` | 探测失败 | 显式填 `TABBIT_EXE` |
| 委派报错说网关不可达 | 网关没跑、且插件启动命令不对 | 检查插件的 `gatewayStartCwd` / `gatewayStartCommand` |
| 子代理答非所问、说"没看到任务" | 预设没建、或挂错了 | 确认 `presetId` 指向的预设存在且是 `complete: true` |
| 改了设置但模型没变 | 预设里写了 `agentOptions` | 删掉它（见步骤 5） |
| 模型列表为空 | 账号套餐/地区不含该模型 | `curl /v1/models` 看实际可用项 |

---

## 平台支持

**目前只在 Windows 上验证过。** 已知的 Windows 依赖：

- 网关用 `tasklist` / `taskkill` 管理浏览器进程
- 浏览器路径探测读 Windows 卸载注册表

macOS / Linux 需要移植这两处，目前**不可用**。

---

## 已知的粗糙处

**步骤 1 已经不再需要手工打补丁**——`gateway-patch/install.mjs` 一条命令搞定
（clone + 覆盖 + 写配置）。

**但有个我们解决不了的限制**：上游 `goehou/tabbit-toy` **没有 LICENSE 文件**，
所以网关没法作为独立仓库发布（见步骤 1 的说明）。这意味着我们永远依赖上游仓库
可访问。如果它消失或被设为私有，本项目的步骤 1 就会失效。

如果你在步骤 1 卡住，请提 issue 说明卡在哪。
