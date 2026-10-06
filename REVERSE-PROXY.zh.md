# 反代原理

[English](REVERSE-PROXY.md) | **简体中文**

这份文档讲清楚**网关到底做了什么**：把 Tabbit 浏览器的 AI 后端，翻译成
OpenAI 兼容 API。

> **为什么这份文档必须存在**：整个项目的起点是这一步。网关不是魔法盒子——
> 它是一组具体的 HTTP 调用加上一套签名头。把这些写清楚，后面所有步骤
> （装网关、注册 provider、建预设）才有立足点；出了问题也才有地方查。
>
> 这些知识是**逆向得到的**（参考了上游项目的分析，并用本机抓包与实测核对过）。
> 我们重新组织并写在这里，作为本项目需要的前置操作之一。

---

## 一、链路总览

```
DSH 主对话
   │  委派（subagent_tabbit）
   ▼
本插件（dsh-tabbit-brain）       ← 保证网关在跑
   │  OpenAI 格式请求
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
2. 给每个请求签上 Tabbit 后端要验的签名头
3. 把 Tabbit 的 SSE 流翻译回 OpenAI 的 SSE 流

---

## 二、认证：两条腿

Tabbit 后端要两样东西，缺一不可。

### 2.1 会话 Cookie（第一条腿）

就是你在浏览器里登录后的那串 cookie，含一个 `token`（JWT）。

**它只能从浏览器里拿**——这是本项目为什么依赖「已登录的 Tabbit」的原因。
网关用 CDP 从一个短命 headless 实例里读出来（见 `gateway-patch/README.md`）。

### 2.2 签名 Key（第二条腿）

`GET /chat/sign-key` 可以拿到它。上游代码里还内置了一个**默认常量**作为回落值
（位置：网关源码 `scripts/lib/tabbit.mjs` 的 `DEFAULT_SIGN_KEY`）——
**我们刻意不在这里写出它的字面值**：它属于 Tabbit，不是我们的东西，
而且随版本可能变化，写进文档只会制造一个会过期的"事实"。

网关的策略是：**优先用拉取到的**，拉取失败才回落到那个常量；并且每 10 分钟重新拉一次。

---

## 三、请求头：签名怎么算

每个请求要带这些头：

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

`GET` 类请求（如模型列表）的 body 视为空串，即 `sha256('')`。

> **凭名字猜会写错**。按 `x-signature=签名、x-nonce=随机数` 去实现，后端会直接拒。
> 这是逆向最容易翻车的地方之一，所以单独拎出来说。

---

## 四、端点清单

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/proxy/v1/model_config/models?a=0&scene=chat` | 模型列表（**需要签名**） |
| `GET` | `/chat/sign-key` | 拉签名 key |
| `POST` | `/api/v1/chat/completion` | **核心：聊天补全（SSE 流）** |
| `POST` | `/proxy/v0/chat/stop/` | 停止生成 |
| `POST` | `/proxy/v0/cos/presigned-upload-url` | 图片上传①：拿预签名地址 |
| `PUT` | （预签名地址，COS） | 图片上传②：直接传字节 |
| `POST` | `/api/v0/cos/complete-upload` | 图片上传③：登记 |

> **Agent 模式**（`wss /api/agent/v2/ws`，浏览器自动化）本项目未实现。

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

- **`chat_session_id` 不能是新的**：Tabbit 按会话计费/管理上下文。网关会先
  `GET` 会话列表拿一个已存在的会话 id 并缓存（5 分钟）。**没有会话就调不通。**
- **`task_name`**：普通对话是 `chat`，Agent 模式是 `task`。
- **`metadatas.html_content`**：Tabbit 前端发的是 HTML，不是纯文本。
- **`entity.key`**：固定常量 `d41d8cd98f00b204e9800998ecf8427e`（这是
  md5('') 的值，一个占位标识）。

### messages → content 的拼接规则

**这里有一个实测出来的限制**：Tabbit 后端对输入长度有上限（**约 20500 字符**，超了返回 492）。
网关自己卡在 **19000** 留出余量，并且**按优先级分配预算**，而不是简单截断：

```
最新一条 user 消息   >   系统提示（开头）   >   近期历史
```

其中最新 user 消息单独有 **12000** 字符的上限。（另：单次最多带 4 张图）

> **这个限制解释了一个真实的故障**：早期直接委派时，提示词到 61,031 字符，
> 被截断后模型只看到"框架注入 + 技能清单"，**任务整个丢失**。
> 本插件的"独立预设"设计就是为了把提示词压到 KB 级，从根上避开这个限制。

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
| 签名默认 key 失效 | 上游常量，随版本可能变 | 网关优先拉取，失败才回落 |

---

## 九、我们改了什么

上游网关能跑，但在**无人值守**场景下有几个硬伤。我们的改动都在
[`gateway-patch/`](gateway-patch/README.md)：

1. **cookie 续期**：上游要求浏览器带 `--remote-debugging-port` 启动。我们改成
   **短命 headless 实例**——按需起、取完即杀，全程无窗口、不留常驻进程。
2. **路径自动探测**：上游要写死 `TABBIT_EXE`。我们改成扫注册表探测
   （**不依赖 DisplayName 的字面值**，中文系统上它叫「Tabbit浏览器」）+ 标准位置兜底。

驱动这两项改动的理由、以及实测数据，见 `gateway-patch/README.md`。
