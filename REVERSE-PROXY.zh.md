# 反代原理

[English](REVERSE-PROXY.md) | **简体中文**

这份文档讲清楚**网关到底做了什么**：把 Tabbit 浏览器的 AI 后端，翻译成
OpenAI 兼容 API。

> **为什么这份文档必须存在**：整个项目的起点是这一步。网关不是魔法盒子——
> 它是一组具体的 HTTP 调用加上一套签名头。把这些写清楚，后面所有步骤
> （装网关、配置 Brain 专用提示词）才有立足点；出了问题也才有地方查。
>
> 这些知识是**逆向得到的**（参考了上游项目的分析，并用本机抓包与实测核对过）。
> 我们重新组织并写在这里，作为本项目需要的前置操作之一。

---

## 一、链路总览

```
DSH 主对话
   │  私有推理（tabbit_brain）
   ▼
按 owner 隔离的 Brain service  ← 专用提示词与 SQLite 历史
   │  OpenAI 格式请求 + X-Brain-Conversation-Id
   ▼
网关（本地，127.0.0.1:8787）      ← 翻译层：OpenAI ⇄ Tabbit
   │  Tabbit 私有格式 + 签名头
   ▼
https://web.tabbit.com           ← Tabbit 自有后端（再转发到真实 LLM）
   │
   ▼
模型（DeepSeek / GLM / MiniMax …）
```

**关键点**：网关自己**不产生**任何智能。它只做三件事：

1. 把 OpenAI 的 `messages` 拼成 Tabbit 要的单个 `content` 字符串
2. 给 chat/models API 请求签上 Tabbit 后端要验的签名头
3. 把 Tabbit 的 SSE 流翻译回 OpenAI 的 SSE 流

---

## 二、认证：两条腿

Tabbit 后端要两样东西，缺一不可。

### 2.1 会话 Cookie（第一条腿）

就是你在浏览器里登录后的那串 cookie，含一个 `token`（JWT）。

**它只能从浏览器里拿**——这是本项目为什么依赖「已登录的 Tabbit」的原因。
网关用 CDP 从一个短命 headless 实例里读出来（见 `gateway-patch/README.md`）。

### 2.2 签名 Key（第二条腿）

approved 网关的 `ensureSignKey` 对显式配置的固定 key 直接使用。
未固定 key 时，自动获取采用请求驱动的 10 分钟 TTL 刷新；
这不是后台定时器。`ensureSignKey` 直接等待获取结果；获取失败会传播错误，无 catch 或失败回落。
上游 client 在 HTTP 响应不成功时抛错；成功响应的空正文才返回 `DEFAULT_SIGN_KEY`。

网关初始化也使用这个默认常量。它位于 `scripts/lib/tabbit.mjs`；
**我们刻意不在这里写出它的字面值**：它属于 Tabbit，随版本可能变化，
写进文档只会制造一个会过期的事实。

---

## 三、请求头：签名怎么算

下表描述签名的 chat/models 请求，不适用于全部上游 HTTP 请求。

- `POST /panel/session` 无 body；它与 `GET /panel/{id}/data` 仅带 `Cookie`、`Accept`、`Origin` 和 `Referer`。
  两者不带 Content-Type、签名或指纹头；均使用 `redirect: error`。
- `GET /chat/sign-key` 使用基础请求头，不签名。
- 预签名 COS 对象存储 `PUT` 不使用这些 Tabbit 签名/指纹头。

| 头 | 值 | 说明 |
|---|---|---|
| `Cookie` | 会话 cookie | 见 2.1 |
| `x-req-ctx` | `base64(版本号)` | 例如 `1.15.17(10115017)` 的 base64 |
| `unique-uuid` | 设备标识 | 32 位十六进制，**基于当前时间戳**生成；第 6 位是浏览器类型标记（默认版 `1`）。不是版本号推导的 |
| `trace-id` | 随机 UUID | 每请求一个，用于链路追踪 |
| `User-Agent` | Chrome UA | 伪装成浏览器 |
| `Origin` / `Referer` | 后端域名 | |
| `x-timestamp` | `Date.now()` | |
| `x-signature` | **随机 UUID** | ⚠️ 见下 |
| `x-nonce` | **HMAC 值** | ⚠️ 见下 |

### ⚠️ 命名是反直觉的

这是最容易踩的坑：**两个头的名字和内容对不上**。

```
x-timestamp = String(Date.now())
x-signature = randomUUID()                                   ← 它其实是随机数
x-nonce     = HMAC-SHA256(signKey, `${ts}.${uuid}.${sha256(body)}`)   ← 它才是签名
```

**签名原文的构造**（按顺序拼接）：

```
message = `${x-timestamp}.${x-signature}.${sha256Hex(requestBody)}`
```

然后：

```
x-nonce = HMAC-SHA256(signKey, message)   → 十六进制小写
```

签名的 `GET` 请求（如模型列表）的 body 视为空串，即 `sha256('')`。

> **凭名字猜会写错**。按 `x-signature=签名、x-nonce=随机数` 去实现，后端会直接拒。
> 这是逆向最容易翻车的地方之一，所以单独拎出来说。

---

## 四、端点清单

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/proxy/v1/model_config/models?a=0&scene=chat` | 模型列表（**需要签名**） |
| `GET` | `/chat/sign-key` | 拉签名 key（不签名） |
| `POST` | `/panel/session` | 创建空远端会话（无 body；仅会话请求头） |
| `GET` | `/panel/{id}/data` | 校验会话 ID 匹配且历史为空（仅会话请求头） |
| `POST` | `/api/v1/chat/completion` | **核心：聊天补全（SSE 流）** |
| `POST` | `/proxy/v0/chat/stop/` | 停止生成 |
| `POST` | `/proxy/v0/cos/presigned-upload-url` | 图片上传①：拿预签名地址 |
| `PUT` | （预签名地址，COS） | 图片上传②：直接传字节 |
| `POST` | `/api/v0/cos/complete-upload` | 图片上传③：登记 |

`{id}` 是远端会话 ID 占位符；下文 `GET /panel/id/data` 采用同一占位写法，`id` 不是字面路径段。

> **Agent 模式**：请求桥会把 `agent_mode` 和 `task_name` 转发到上游聊天端点，但本网关没有实现 Tabbit 的浏览器自动化 WebSocket（`wss /api/agent/v2/ws`），也没有用户浏览器控制通道。黑盒测试中观察到 `browser_task_tool` 事件但结果为空，因此浏览器执行仍应视为未验证。模型文字中返回的 `browser_control` 指令不会由本网关继续执行。

---

## 五、聊天请求的报文结构

这是翻译层的核心。OpenAI 传来的是 `messages` 数组，Tabbit 要的是**一个字符串**。

```json
{
  "chat_session_id": "<会话 id>",
  "message_id": null,
  "content": "<把 messages 拼成的完整文本>",
  "selected_model": "<模型名>",
  "parallel_group_id": null,
  "task_name": "chat",
  "agent_mode": false,
  "metadatas": { "html_content": "<p>...</p>" },
  "references": [],
  "entity": { "key": "d41d8cd98f00b204e9800998ecf8427e", "extras": { "type": "tab", "url": "" } }
}
```

几个要点：

- **`chat_session_id` 使用远端创建后返回的 ID**，而非本地随意生成的 ID。Brain 以 `POST /panel/session` 创建空会话，再用 `GET /panel/id/data` 校验 ID 匹配且历史为空。
  `X-Brain-Conversation-Id` 将本地会话绑定到此远端会话；`state/brain-session-map.json` 按 `accountKey` 与 `baseURL` 记录绑定。
  provenance 为 `created`、`pool`、`legacy` 或 `unverified`；已有非 `created` Brain 绑定以 409 fail closed。scope 与恢复说明见 SETUP。
- **`task_name`**：普通对话是 `chat`，Agent 模式是 `task`。
- **`metadatas.html_content`**：Tabbit 前端发的是 HTML，不是纯文本。
- **`entity.key`**：固定常量 `d41d8cd98f00b204e9800998ecf8427e`（这是
  md5('') 的值，一个占位标识）。

### messages → content 的拼接规则

Brain 发送专用提示词和显式提供的任务材料，不继承 DSH 预设或技能目录。需要 DSH 专有 Skill 时，必须由主代理先执行，再把相关结果作为文字传入；单独提供本机路径或 Skill 名称不能让 Brain 读取。插件使用 `contextBudgetChars` 为当前任务及近期完整问答对分配预算；当前任务超限时报错，不静默截断。拼接内容中的 `[System]` 是文本角色标记，不是原生 system 角色传输。

上游 Tabbit 服务可以使用自己的搜索/网页抓取工具和自己的 Skill/妙招资料检索，但这不是 DSH 技能目录。上游浏览器任务事件、`agent_mode` 和 `browser_control` 指令都已被观察到；本网关没有实现浏览器自动化 WebSocket，也不会执行返回的浏览器控制指令。`show_widget` 结果可以由本网关捕获并保存；DSH 客户端内嵌渲染不属于本协议契约。

生产 Brain create 失败直接暴露错误，不 fallback 到池会话。Brain pool 相关的 409 兼容仅属于显式选择的兼容 fixture；独立 legacy mode 保留可运行的列表池路径。Task4 的 83 项源码测试和独立 review 已通过，本机部署也已有默认端口、重启、新会话、A/B、后台任务和分页证据。created 空会话 fixture 不证明远端隐藏账号记忆不存在，该结论尚未证明。能力验收另行分层：搜索/网页抓取、读图、Tabbit 自有 Skill 资料检索和网关 Widget 捕获已通过；浏览器任务执行、browser_control 执行和客户端内嵌渲染仍未验证。

历史观测：早期抓包记录过约 20500 字符附近的输入阈值，也记录过 61,031 字符的继承提示词在截断后丢失任务材料。这些数字不是当前后端上限，也不代表错误码 492 的通用含义。legacy 拼接预算须以部署网关为准；Brain 专用提示词不是配套 DSH 预设。

---

## 六、SSE 流格式

后端返回 `text/event-stream`，标准的 SSE：

```
event: message_chunk
data: {"type":"...","content":"..."}

id: 123
```

网关的解析器按 `event:` / `data:` / `id:` 三个字段处理，以**空行**作为一条消息的结束。
然后翻译成 OpenAI 的 `data: {...}\n\n` 格式。

---

## 七、图片：为什么"能看懂"但不能"看像素"

图片走的是**三步上传**，不是 base64 内联：

```
① POST /proxy/v0/cos/presigned-upload-url   → 拿预签名地址 + file_id
② PUT  <预签名地址>                          → 直接传图片字节到对象存储
③ POST /api/v0/cos/complete-upload          → 登记
```

然后在消息的 `references` 里加一条：

```json
{
  "id": "...",
  "type": "image",
  "title": "image.png",
  "file_id": "...",
  "attachment_id": "...",
  "content": "..."
}
```

> ⚠️ **字段名必须含下划线**（`file_id`、`attachment_id`），写成驼峰后端不认。
>
> ⚠️ **Tabbit 后端会把图片转成自然语言描述**再喂给模型——所以模型"能看懂内容"，
> 但**拿不到像素级信息**（精确色值、坐标、计数都会失败）。实测验证过。

---

## 八、我们知道它不完美的地方

诚实记录，免得后来人重复踩：

| 现象 | 原因 | 状态 |
|---|---|---|
| 错误码 **492** 被当成鉴权失败 | 492 是**配额用尽**，不是鉴权问题。网关见到它就白跑一次 cookie 刷新 | 已知小瑕疵 |
| 模型列表为空 | 账号套餐/地区不含该模型 | 正常行为 |
| 图片理解停在语义层 | 后端转描述（见第七节） | 设计如此，非缺陷 |
| 签名默认 key 失效 | 上游常量，随版本可能变 | 固定 key 直接使用；自动获取错误会传播 |

---

## 九、我们改了什么

上游网关能跑，但在**无人值守**场景下有几个硬伤。我们的改动都在
[`gateway-patch/`](gateway-patch/README.md)：

1. **cookie 续期**：上游要求浏览器带 `--remote-debugging-port` 启动。我们改成
   **短命 headless 实例**——按需起、取完即杀，全程无窗口、不留常驻进程。
2. **路径自动探测**：上游要写死 `TABBIT_EXE`。我们改成扫注册表探测
   （**不依赖 DisplayName 的字面值**，中文系统上它叫「Tabbit浏览器」）+ 标准位置兜底。

驱动这两项改动的理由、以及实测数据，见 `gateway-patch/README.md`。
