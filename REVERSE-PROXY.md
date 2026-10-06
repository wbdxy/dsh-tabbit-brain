# How the reverse proxy works

**English** | [简体中文](REVERSE-PROXY.zh.md)

This document explains **what the gateway actually does**: it translates Tabbit
Browser's AI backend into an OpenAI-compatible API.

> **Why this document exists**: this step is where the whole project starts. The
> gateway is not a magic box — it is a specific set of HTTP calls with a specific
> set of signed headers. Writing that down gives every later step (install the
> gateway, register the provider, create the preset) something to stand on, and
> gives you somewhere to look when something breaks.
>
> This knowledge was **reverse-engineered** (from the upstream project's analysis,
> cross-checked against our own traffic captures and experiments). We reorganised
> and wrote it down here, as one of the prerequisite operations this project needs.

---

## 1. The chain

```
DSH main conversation
   │  delegation (subagent_tabbit)
   ▼
this plugin (dsh-tabbit-brain)        <- keeps the gateway alive
   │  OpenAI-shaped request
   ▼
gateway (local, 127.0.0.1:8787)       <- translation layer: OpenAI <-> Tabbit
   │  Tabbit-private format + signed headers
   ▼
https://web.tabbit.com                <- Tabbit's own backend (forwards to real LLMs)
   │
   ▼
models (DeepSeek / GLM / MiniMax …)
```

**The gateway produces no intelligence of its own.** It does exactly three things:

1. Flattens OpenAI's `messages` array into the single `content` string Tabbit wants
2. Signs each request with the headers Tabbit's backend verifies
3. Translates Tabbit's SSE stream back into OpenAI's SSE stream

---

## 2. Two-legged authentication

Tabbit's backend wants two things, and neither alone is enough.

### 2.1 The session cookie

The cookies from your browser login, including a `token` (a JWT).

**It can only come from a browser.** That is why this project requires a
signed-in Tabbit. The gateway reads it over CDP from a short-lived headless
instance (see `gateway-patch/README.md`).

### 2.2 The signing key

`GET /chat/sign-key` returns it. The upstream code also carries a built-in default
(`f8d0e6a73f8d4b1a9c3d2e1f9a4b7c6d`); the gateway prefers the fetched one and
falls back to the constant.

> ⚠️ That default is **not ours** — it is a constant baked into the upstream
> project, and a future version could invalidate it. The gateway re-fetches every
> 10 minutes.

---

## 3. Headers: how the signature is computed

Every request carries:

| Header | Value | Notes |
|---|---|---|
| `Cookie` | session cookie | see 2.1 |
| `x-req-ctx` | `base64(version)` | e.g. base64 of `1.15.17(10115017)` |
| `unique-uuid` | device identity | 32 hex chars, **generated from the current timestamp**; position 6 is a browser-type marker (`1` for the default build). Not derived from the version |
| `trace-id` | random UUID | one per request, for tracing |
| `User-Agent` | Chrome UA | poses as the browser |
| `Origin` / `Referer` | backend origin | |
| `x-timestamp` | `Date.now()` | |
| `x-signature` | **a random UUID** | ⚠️ see below |
| `x-nonce` | **the HMAC** | ⚠️ see below |

### ⚠️ The naming is counterintuitive

This is the easiest trap in the whole protocol: **two headers whose names do not
match their contents.**

```
x-timestamp = String(Date.now())
x-signature = randomUUID()                                            <- actually a nonce
x-nonce     = HMAC-SHA256(signKey, `${ts}.${uuid}.${sha256(body)}`)   <- actually the signature
```

The signed message is built by concatenating, in order:

```
message = `${x-timestamp}.${x-signature}.${sha256Hex(requestBody)}`
```

then:

```
x-nonce = HMAC-SHA256(signKey, message)   -> lowercase hex
```

For `GET` requests (such as the model list) the body counts as the empty string,
i.e. `sha256('')`.

> **Guessing from the names produces broken code.** Implement it as
> `x-signature = signature, x-nonce = nonce` and the backend rejects you outright.
> It is one of the places reverse engineering most often goes wrong, which is why
> it gets called out on its own.

---

## 4. Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/proxy/v1/model_config/models?a=0&scene=chat` | model list (**signed**) |
| `GET` | `/chat/sign-key` | fetch the signing key |
| `POST` | `/api/v1/chat/completion` | **the core: chat completion (SSE stream)** |
| `POST` | `/proxy/v0/chat/stop/` | stop generation |
| `POST` | `/proxy/v0/cos/presigned-upload-url` | image upload 1: get a presigned URL |
| `PUT` | (presigned URL, object storage) | image upload 2: send the bytes |
| `POST` | `/api/v0/cos/complete-upload` | image upload 3: register it |

> **Agent mode** (`wss /api/agent/v2/ws`, browser automation) is not implemented here.

---

## 5. The chat request

This is the heart of the translation layer. OpenAI sends a `messages` array;
Tabbit wants **one string**.

```json
{
  "chat_session_id": "<session id>",
  "message_id": null,
  "content": "<all messages flattened into one text>",
  "selected_model": "<model name>",
  "parallel_group_id": null,
  "task_name": "chat",
  "agent_mode": false,
  "metadatas": { "html_content": "<p>...</p>" },
  "references": [],
  "entity": { "key": "d41d8cd98f00b204e9800998ecf8427e", "extras": { "type": "tab", "url": "" } }
}
```

Notes:

- **`chat_session_id` cannot be new.** Tabbit tracks context and quota per session.
  The gateway fetches an existing session id and caches it for 5 minutes.
  **Without a session, nothing goes through.**
- **`task_name`**: `chat` for ordinary conversation, `task` in agent mode.
- **`metadatas.html_content`**: the frontend sends HTML, not plain text.
- **`entity.key`**: a fixed constant, `d41d8cd98f00b204e9800998ecf8427e`
  (the md5 of the empty string — a placeholder identity).

### Flattening messages into content

**A measured constraint**: Tabbit's backend caps input length (**around 20,500 characters**;
exceeding it returns 492). The gateway holds itself to **19,000**, leaving margin,
and spends that budget **by priority** rather than truncating blindly:

```
latest user message  >  system head  >  recent history
```

with the latest user message capped at **12,000** characters on its own. (Also: at most 4 images per request.)

> **This constraint explains a real failure.** Early on, a delegated prompt reached
> 61,031 characters; after truncation the model saw only "framework injection plus a
> skills list" and **lost the task entirely**. The plugin's separate-preset design
> exists to keep prompts in the kilobytes and avoid the cap from the start.

---

## 6. The SSE stream

The backend returns `text/event-stream` — ordinary SSE:

```
event: message_chunk
data: {"type":"...","content":"..."}

id: 123
```

The gateway's parser handles `event:` / `data:` / `id:` and treats a **blank line**
as the end of one message, then re-emits it as OpenAI's `data: {...}\n\n`.

---

## 7. Images: why it "understands" but cannot "see pixels"

Images go through a **three-step upload**, not inline base64:

```
1. POST /proxy/v0/cos/presigned-upload-url  -> presigned URL + file_id
2. PUT  <presigned URL>                     -> the bytes, straight to object storage
3. POST /api/v0/cos/complete-upload         -> register it
```

Then a `references` entry is attached to the message:

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

> ⚠️ **The field names must keep their underscores** (`file_id`,
> `attachment_id`). Camel-case variants are not accepted.
>
> ⚠️ **Tabbit's backend converts images into natural-language descriptions** before
> the model sees them. So the model "understands the content" but **gets no
> pixel-level information** — exact colours, coordinates, and counts all fail.
> We verified this.

---

## 8. What we know is imperfect

Recorded so nobody has to rediscover it:

| Symptom | Cause | Status |
|---|---|---|
| Error **492** treated as an auth failure | 492 means **quota exhausted**, not bad auth. The gateway wastes one cookie refresh on it | known minor flaw |
| Empty model list | your tier/region lacks the model | expected behaviour |
| Image understanding stops at semantics | backend converts to a description (section 7) | by design, not a defect |
| The default signing key stops working | upstream constant, may change per version | gateway prefers the fetched key |

---

## 9. What we changed

The upstream gateway works, but has hard edges for an **unattended** deployment.
Our changes live in [`gateway-patch/`](../gateway-patch/README.md):

1. **Cookie renewal**: upstream expects the browser to have been started with
   `--remote-debugging-port`. We use a **short-lived headless instance** instead —
   started on demand, killed the moment the cookies are read. No window, no
   resident process.
2. **Path auto-detection**: upstream wants `TABBIT_EXE` written out by hand. We scan
   the uninstall registry — deliberately **not matching on the literal display
   name**, which reads `Tabbit浏览器` on a Chinese system — plus standard locations.

The reasoning and the measurements behind both are in `gateway-patch/README.md`.
