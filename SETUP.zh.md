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
| 部署网关（第三方项目 + 补丁） | 你 | ⚠️ 见下，目前比较麻烦 |
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

---

## 一键助手：把手工编辑变成命令

下面第 3、4、5 步本来要你手工编辑 YAML。本插件带了一个脚本代替它们：

```bash
cd <插件目录>
node scripts/setup.mjs --help         # 看全部参数；★ 标出必须你自己填的
node scripts/setup.mjs --dry-run      # 先看会改什么，不动任何文件（建议第一次这样跑）
```

### 你必须自己填的值

| 参数 | 从哪来 | 不填会怎样 |
|---|---|---|
| ★ `--api-key <key>` | **你自己在网关 `.env` 里设的 `API_KEY`** | 用默认 `sk-tabbit-local`；与网关不一致则全部 401 |
| ★ `--models <id,id>` | `curl <网关>/v1/models -H "Authorization: Bearer <key>"` | 脚本会打印取模型的命令，但不写入 |
| ★ `--mount-preset <name>` | 你**主对话用的预设**名（如 `router-standard`） | 会尝试从 `settings.yaml` 推断，推不出就只打印片段 |
| `--profile <name>` | `~/.dsh/profiles/` 下的目录名 | 默认 `desktop` |
| `--base-url <url>` | 网关地址 | 默认 `http://127.0.0.1:8787/v1` |
| `--preset-id <id>` | 子代理挂载的预设 id | 默认 `tabbit-brain`，一般不用改 |
| `--provider <name>` | provider 注册名 | 默认 `tabbit-local` |

### 常用组合

```bash
# 只打印要加的内容，不改任何文件（默认行为）
node scripts/setup.mjs --models DeepSeek-V4.1-Flash,GLM-5.3

# 真正写入（会先备份成 .bak-setup-*）
node scripts/setup.mjs --models DeepSeek-V4.1-Flash,GLM-5.3 --write-settings --mount-preset router-standard
```

**脚本的边界**：只做加法和备份。已存在的条目**跳过而不是覆盖**（要覆盖加 `--force`），
改动前一律先备份，找不到的地方明确告诉你还差什么。

---

## 步骤 3：注册 provider

**用上面的助手**（推荐）：

```bash
node scripts/setup.mjs --models <你的模型id> --write-settings
```

**或者手工写**。编辑 `~/.dsh/settings.yaml`：

```yaml
llm-pi-ai:
  providers:
    tabbit-local:                    # ← 改成你想用的 provider 名
      displayName: Tabbit 本地网关
      apiKeyEnv: TABBIT_API_KEY
      baseURL: http://127.0.0.1:8787/v1   # ← 你的网关地址
      models:
        - id: DeepSeek-V4.1-Flash    # ← 换成你账号里实际有的
          inputModalities: [text, image]
        - id: GLM-5.3                # ← 同上
          inputModalities: [text, image]
```

拿到你的模型列表：

```bash
curl http://127.0.0.1:8787/v1/models -H "Authorization: Bearer <你的key>"
```

设 API key 环境变量（**值必须与网关 `.env` 的 `API_KEY` 一致**）：

```powershell
[Environment]::SetEnvironmentVariable('TABBIT_API_KEY', '<你的key>', 'User')
```

---

## 步骤 4：创建子代理预设

**用助手**（推荐）：

```bash
node scripts/setup.mjs     # 会自动创建 ~/.dsh/.agent-presets/<presetId>/
```

**或者手工建两个文件**（内容见下）。预设住在 `~/.dsh/.agent-presets/`，
那是**用户状态**、不是包内容，所以**没法随插件分发**——每个用户都要做一次。

---

## 步骤 5：挂载委派工具

**用助手**（推荐）：

```bash
node scripts/setup.mjs --mount-preset <你主对话用的预设名>
```

**或者手工**在你主对话用的预设里加一行（见下方 YAML）。

---

## 步骤 6：验证


编辑 `~/.dsh/settings.yaml`，加一个 OpenAI 兼容 provider：

```yaml
llm-pi-ai:
  providers:
    tabbit-local:
      displayName: Tabbit 本地网关
      apiKeyEnv: TABBIT_API_KEY
      baseURL: http://127.0.0.1:8787/v1
      models:
        - id: DeepSeek-V4.1-Flash
          inputModalities: [text, image]
        - id: GLM-5.3
          inputModalities: [text, image]
```

> **模型名要填你账号里实际有的**。跑 `curl http://127.0.0.1:8787/v1/models -H "Authorization: Bearer sk-tabbit-local"`
> 看列表，把这里换成其中的 id。不同账号/地区的可用模型不一样。

设置 API key 环境变量（值与网关 `.env` 的 `API_KEY` 一致）：

```powershell
[Environment]::SetEnvironmentVariable('TABBIT_API_KEY', 'sk-tabbit-local', 'User')
```

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
