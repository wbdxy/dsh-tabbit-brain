# dsh-tabbit-brain

[English](README.md) | **简体中文**

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 子代理提供方：
让子代理获得一份**干净、专用的系统提示词**，而不是继承父会话的组合。

它存在的理由是**一次实测到的具体故障**——见[为什么需要它](#为什么需要它)。

---

> **需要已登录的 Tabbit 账号。** 完整走查见 [SETUP.zh.md](SETUP.zh.md)。

## 为什么需要它

DSH 内置的 `spawn` / `fork` 驱动用
`applyChildComposition(childCtx, parent, …)` 组合子代理：**子代理继承父预设**。
如果父预设很大——比如路由预设、挂载了技能目录的预设、注入了 persona 框架的预设——
这些内容会全部落进子代理的系统提示词。

`persona` 配置**只能遮蔽 persona 那一段**，删不掉其他注入段。

在一台接了本地 Tabbit 网关（输入上限约 20,500 字符）的机器上实测同一个委派任务：

| | 改造前 | 改造后 |
|---|---|---|
| 发给上游的子代理提示词 | **61,031 字符**，被截断到 18,635 | 未超上限，**无截断** |
| 子会话记录的预设 | 继承的 `router-standard` | **`tabbit-brain`** |
| 子会话体积 | — | 51 KB（父会话 5.1 MB） |
| 模型的反馈 | *「这条消息是框架注入加技能清单，没有任务」* | 完整、正确的交付物 |

**任务被埋在了 61 KB 它用不上的提示词里。**

---

## 工作原理

DSH 有三个接缝，本插件三个都用上了。

**① `subagents` 提供方注册表。** 一个提供方就是个小对象：

```js
{ name, capabilities, inheritsParentContext, start(request), prepareContinuable() }
```

**② `agentPresets.mount(agentCtx, id)`。** agent 工厂的 `setup` 运行在子代理的
创建窗口内，且**支持 async**。内置驱动是去**加入父级组合**，本插件改成**挂自己的预设**：

```js
// 内置驱动：子代理继承父预设
applyChildComposition(childCtx, parent, { persona, toolFilter })

// 本插件：子代理挂独立预设
await presets.mount(childCtx, opts.presetId)
```

`setup` 里抛错会**回滚 agent 创建**，所以坏掉的预设不会留下半装配的会话。

**③ 技能目录来自预设层。** 当 agent 没有加入任何预设时，DSH 会告警：

> its tools, prompt sections, and **skill catalog** resolve against the empty
> global layer

所以一个 persona 为 `complete: true`（且不挂任何工具行）的预设，能拿到真正干净的提示词
——**后续装配监听器无法再往里加文本**。

最终形态：

```
主 agent（完整工具，大预设）
  └─ subagent_tabbit  ──►  provider "tabbit"
                             └─ 子代理挂载预设 "tabbit-brain"
                                  persona complete:true，约 926 字符，无工具
                                  路由到 Tabbit 网关上的模型
```

子代理能推理但不能动手；父 agent 能动手。**这个分工就是重点。**

---

## 我们建立在什么之上

整个项目建立在一件事上：**把 Tabbit 的 AI 后端翻译成 OpenAI 兼容 API**。
网关不是魔法盒子——它是一组具体的 HTTP 调用加上一套签名头，而这些**全部写下来了**：

**[REVERSE-PROXY.zh.md](REVERSE-PROXY.zh.md)** —— 认证链、签名方案（含**两个头名字
与内容反直觉**的那个坑）、请求报文结构、导致过真实故障的输入上限、以及已知的不完美。

读了它，后面每一步都有立足点；不读，出问题只能猜。

## 安装之前

有两件事必须在你的机器上成立，而且**都无法自动化**：

1. **已安装 Tabbit 浏览器，并且已登录账号。** Cookie 续期的原理是从你自己的浏览器里
   读出登录会话——没有账号就没有 cookie，整条链路不工作。账号免费，但登录是硬前提。
2. **你得有个地方跑网关。** 本插件负责保证网关在跑、并向它委派——但**不提供**网关。
   见安装文档。

**完整的分步走查（哪些是你做、哪些是自动的）：[SETUP.zh.md](SETUP.zh.md)**

需要你手工做的：部署网关、安装插件、注册 provider、建子代理预设、挂载委派工具。
自动完成的：拉起网关、探测浏览器位置、续期 cookie、注入委派指引。

## 安装

```bash
# 从 npm（发布后）
dsh plugin --profile <profile> add dsh-tabbit-brain

# 从本地目录
dsh plugin --profile <profile> add link:/path/to/dsh-tabbit-brain
```

然后挂载委派工具。在 agent 预设里加一个 `tool-subagent` 实例：

```yaml
- id: tool-subagent-tabbit
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: tabbit            # 与下面的 providerName 对应
    toolName: subagent_tabbit
    backgroundMode: continuable
    # 不要写 persona     —— 被子代理挂载的预设提供提示词
    # 不要写 agentOptions —— 路由由本插件的设置决定
```

> **这两处省略都是刻意的。** `persona` 没必要，因为子代理挂的是整个预设。
> `agentOptions` 则**有害**：它会被 `tool-subagent` 解析进 `request.agentOptions`，
> 在那里**优先级高于本插件的设置**——于是你在设置界面改了模型却不会生效。

---

## 配套预设

提供方挂载的是 `presetId` 指定的预设，所以那个预设必须存在。
最小的形态是这样（以 DSH 自带的 `minimal` 预设为模板，去掉它的持久 shell 行）：

```yaml
# ~/.dsh/.agent-presets/tabbit-brain/agent.cordis.yml
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    complete: true                 # 这段 prefix 就是全部系统提示词
    includeRuntimeContext: false   # 不注入运行时上下文快照
    prefix: |-
      你是一个纯推理单元。你没有工具：不能执行命令、读写文件，
      也访问不到 MCP 服务器或 Skill 注册表。

      你的输出会被一个**拥有这些工具的主 agent** 消费。
      所以请产出自包含的成品——分析、设计、代码、结论——
      不要说"我来读取文件"。需要材料时，明确说出你需要什么，调用方会取回来。

      直接、准确、简洁地回答。不要编造。
```

**一个工具行都不挂。** 对一个调不了工具的模型来说，工具 schema 是纯粹的负担
——既烧输入预算，又会被判为注入尝试。

---

## 配置

设置位于 `tabbit-brain` 命名空间，**热重载**：提供方每次 `start()` 都重新读取，
所以改完下次委派就生效，无需重载插件。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `providerName` | `tabbit` | 注册名。须与工具配置里的 `provider:` 一致。**改动需重载插件。** |
| `presetId` | `tabbit-brain` | 子代理挂载的预设。 |
| `agentProvider` | `tabbit-local` | 子代理默认路由：DSH provider 名。 |
| `agentModel` | `DeepSeek-V4.1-Flash` | 子代理默认路由：模型名。 |
| `gatewayUrl` | `http://127.0.0.1:8787` | 网关基地址；探测它的 `/healthz`。 |
| `gatewayAutoStart` | `false` | 托管网关可用性（见下）。 |
| `gatewayStartCommand` | *(空)* | 启动网关的 shell 命令。留空则不自动启动。 |
| `gatewayStartCwd` | *(空)* | 启动命令的工作目录。 |
| `gatewayStartTimeoutMs` | `20000` | 启动后等待健康检查通过的最长时间。 |
| `diagnostics` | `false` | 写诊断日志。 |
| `diagnosticsPath` | *(插件目录)/trace.log* | 日志路径。 |

优先级从低到高：

```
部署基线（cordis.patch.yml 的 config）
  → 用户设置（tabbit-brain 命名空间）
    → 按次覆盖（启用 modelSelectionSettings 时）
```

### 诊断

需要确认预设挂载是否真的执行了，就把 `diagnostics` 打开：

```
2026-10-05T09:37:59.902Z  setup OK: mounted preset "tabbit-brain" for child 4904ad0b-…
2026-10-05T09:40:38.825Z  settings changed -> preset="tabbit-brain" route=tabbit-local/DeepSeek-V4.1-Flash
```

挂载失败会给出 `setup FAILED: mount("…") threw: …`，并且**回滚子代理创建**，
而不是悄悄跑在错误的预设上。

---

## 网关托管

本地网关是个独立进程。忘了启动、或者崩了没重启，表现出来就是委派跑到一半
冒出一个莫名其妙的网络错误。打开 `gatewayAutoStart`，插件会**按需**把它拉起来：

- **加载时什么都不做。** 网关由第一次真正需要它的委派启动 —— 不为一个你可能
  用不到的常驻进程买单。
- **每次委派前**探测一次 `/healthz`（loopback 调用很便宜，结果缓存 15 秒）。
  不通就 **detached 执行** `gatewayStartCommand`，然后轮询等待健康恢复。
- 仍然起不来时，**委派快速失败**并给出可操作的错误信息，而不是一个谜之网络错误。

```yaml
gatewayUrl: http://127.0.0.1:8787
gatewayAutoStart: true          # 委派需要时拉起
gatewayWarmup: false            # true = DSH 加载时就拉起
gatewayStartCommand: node "src\server.mjs"
gatewayStartCwd: ~/.tabbit-gateway/tabbit-toy
gatewayStartTimeoutMs: 30000
```

想用「常驻进程」换「第一次委派更快」，就把 `gatewayWarmup` 设为 `true`。

两个值得知道的细节：

- **"活着"的判据是任何 HTTP 响应**，不看状态码。网关通常在路由匹配之前鉴权，
  于是不带 key 的探测会拿到 `401`——那依然证明进程在跑。
  （早期版本要求 `2xx`，结果永远认为网关是死的。）
- **拉起的进程是 detached 的**，所以它比 DSH 活得久。如果你已经用别的方式
  保活（服务管理器、计划任务），就把 `gatewayAutoStart` 关掉——
  这是保险丝，不是保姆。

### 浏览器在哪里（以及为什么本插件不管它）

有些网关靠 CDP 从浏览器里读 cookie 来续期。本插件早先的版本管过这件事 ——
启动浏览器、并让它常驻以保持调试端口打开。那是错的归属，也是错的形态。

**cookie 是网关自己的事**，而读取它的干净做法是**短命 headless 实例**：
带调试端口起一个无窗口浏览器，读到 cookie，立刻杀掉。这条路径实测 ——
各阶段都没有可见窗口、第一次就拿到有效 token、之后不留任何常驻进程。

为什么必须是短命的，这一点不明显但很重要：**常驻的 headless 实例占着 profile
锁**，用户之后正常打开浏览器时会被转交给那个隐形实例，**屏幕上什么都不会出现**。
短命实例永远不会挡路 —— 顺带还消掉了与其它浏览器插件的启动竞争。

所以本插件只做一件事：**保证网关可用**。想要 cookie 那套行为，它在网关侧。

`ensureGateway` 与 `pingGateway` 已导出，
供你自己的工具复用：

```js
import { ensureGateway } from 'dsh-tabbit-brain'

const result = await ensureGateway({ gatewayAutoStart: true, gatewayUrl: '…', gatewayStartCommand: '…' })
// -> { ok: true, action: 'started' | 'already-running' | 'cached' }
```

---

## 什么随插件走，什么要你自己建

关于「指引怎么到达 agent」这一点值得单独说明 —— 因为「把这段抄进你的 `AGENTS.md`」
这种分发方式，对别人的安装根本不成立。

**行为指引随插件一起分发。** 插件注册了一个系统提示词段
（`plugin:tabbit-brain-guidance`），告诉 agent 该怎么定位被委派的模型 ——
推理能力同级、没有手、没有记忆，以及最关键的一条：**它的回复是「主张」而非「事实」，
需要校验**。每个安装的每个会话都自动获得，你不需要往 `AGENTS.md` 里写任何东西，
也永远不会因为没碰那个文件而坏掉。

**你的 `AGENTS.md` 仍然归你。** 用它放**这台机器特有的东西**：路径、端口、
你选定的模型、本机怪癖。这就是插件围绕的分层 —— 插件只能携带「对所有人为真」的内容，
而用户自己的指令文件才是放其余一切的地方。

**唯一需要你手工建的是配套预设。** 预设住在 `~/.dsh/.agent-presets/`，
那是用户状态而非包内容 —— 所以它没法塞进 tarball 一起走。照
[配套预设](#配套预设) 一节，每台机器建一次。

| 内容 | 随插件分发？ | 位置 |
|---|---|---|
| provider、工具接线、网关/浏览器托管 | 是 | 包内 |
| 委派指引（提示词段） | 是 | 加载时注入 |
| 设置段（`tabbit-brain`） | 是 | 包内 |
| **子代理预设** | **否** | `~/.dsh/.agent-presets/<id>/` |
| 本机特定说明 | 否 —— 也不该 | 你的 `AGENTS.md` |

## 验证它确实生效

装好后委派一次，确认子会话记录的是你期望的预设：

```bash
python tools/verify_tabbit_brain.py
```

它查三件事：插件加载了、设置段注册了、最近的子代理会话挂的是你的预设
而不是父级的。

---

## 已知限制

- **仅支持一次性委派。** `prepareContinuable()` 返回 `{}`，不实现可继续子代理。
- **`providerName` 在构造期固定。** `subagents` 注册表按名字索引，
  改名必须重载插件。
- **不声明 `outputSchema` 能力。** 不支持结构化输出的子代理。
- **子代理不是"被禁止读"，而是根本没有工具。** 这里的隔离是提示词组合层面的，
  不是权限层面的。
- **依赖 DSH 内部包。** 本插件组合了 `@deepseek-ai/dsh-subagent`、`dsh-agent`、
  `dsh-session`、`dsh-llm`、`dsh-agent-presets`。这些不是稳定的公开 API，
  DSH 升级可能需要跟着改。每处用法都在代码注释里标注了核对位置。

---

## 开发

纯 ESM，无构建步骤。`lib/index.js` 就是产物。

```bash
npm run check     # node --check lib/index.js
```

要让本地插件目录解析 `@deepseek-ai/*`，把它的 `node_modules` 指向你的 DSH 安装
（Windows 用 junction，其他平台用 symlink）。`tools/` 放的是开发期脚本，
属于诊断工具，不在发布范围内。

---

## 许可

[MIT](LICENSE)
