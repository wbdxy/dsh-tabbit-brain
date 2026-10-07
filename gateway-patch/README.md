# gateway-patch — 给 Tabbit 网关打的补丁

本目录做的是一件事：**一条命令把网关装好**，其中包括让 cookie 自动续期所需的全部改动。

---

## 为什么是「安装器」而不是「完整 fork」

上游 [`goehou/tabbit-toy`](https://github.com/goehou/tabbit-toy) **没有附带任何
LICENSE 文件**。未声明许可 = 默认保留所有权利，所以我们**不转发它的代码**。

`install.mjs` 改成在**你的机器上**从官方仓库 clone 一份，再把我们改动的文件覆盖上去。
我们只分发自己写的那部分。

顺带的好处：**上游更新能自然流入**——重跑脚本就拿到上游最新代码 + 我们的改动。

> 如果你认识上游作者，建议请他补一个 LICENSE。这类项目没有许可会挡住很多使用者。

---

## 一键安装

```bash
# 先看会做什么（不写任何文件）
node gateway-patch/install.mjs --dry-run

# 真正执行
node gateway-patch/install.mjs --api-key <你自己定的key> --base-url https://web.tabbit.com
```

### 可选参数与默认值

| 参数 | 说明 | 默认 |
|---|---|---|
| `--base-url <url>` | Tabbit 后端地址。**国内版 `https://web.tabbit.com`，国际版 `https://web.tabbit.ai`** | 国内版 |
| `--api-key <key>` | 网关鉴权 key。自行设置；Brain 插件侧的 `TABBIT_API_KEY` 必须与它一致 | `sk-tabbit-local` |
| `--dir <path>` | 装到哪 | `~/.tabbit-gateway/tabbit-toy` |
| `--port <n>` | 监听端口 | `8787` |

---

## 我们改了什么，为什么

### 新增 `scripts/lib/detect.mjs`

**浏览器安装位置与 profile 自动探测。**

原来的配置要求写死 `TABBIT_EXE=...`，那只有在写它那台机器上成立。开源分发时每台机器
路径都不同，**而且目录名可能是本地化的**（中文系统的「下载」）。

做法是扫 Windows 卸载注册表，关键是**不依赖 DisplayName 的字面值**——Tabbit 在中文
系统上的注册表项叫「Tabbit浏览器」，任何按英文名做白名单的实现都会漏掉。本实现只要名字里含
`tabbit`（大小写不敏感）就算候选，再从 `DisplayIcon` / `InstallLocation` 取可执行文件。

### 修改 `scripts/lib/cdp.mjs` — 新增 `withEphemeralBrowser()`

**用短命 headless 实例取 cookie，取完立刻杀掉。**

三个实测得来的结论，都写在函数注释里：

1. **必须带 `--user-data-dir`** —— 直接 spawn 浏览器可执行文件时它**不会**自己加这个参数
   （只有它自己的启动器会加）。不指定的话 headless 会落到一个空 profile：页面能开，
   但 tabbit 域下 **0 个 cookie**。
2. **不能常驻** —— 常驻的 headless 实例占着 profile 锁，用户之后双击图标会被转交给这个
   无界面实例，**屏幕上什么都不会出现**。
3. **无窗口 ≠ 用户受限** —— 短命实例存活期间无窗口（任务管理器里能看到进程），杀掉之后
   用户随时能正常打开自己的浏览器。

顺带消掉了与其它浏览器插件的启动竞争：实例会短暂占用 profile；同时启动另一个浏览器的场景仍有竞态，见下面的验证边界。

### 修改 `src/config.mjs`

`browserExe` 与 `browserUserDataDir` 改为自动探测（留空即探测，探测失败可手工指定）。

### 六文件安装清单与状态保留

安装器的 `MANIFEST` 是复制、预检和 `--help` 清单的统一来源：

- `scripts/lib/detect.mjs`
- `scripts/lib/cdp.mjs`
- `src/config.mjs`
- `src/server.mjs`
- `src/brain-session-map.mjs`：持久化 Brain 会话映射。
- `src/remote-session-client.mjs`：创建远端会话并检查可见历史。

`src/server.mjs` 继续使用上游客户端的 `sessionId` 参数契约；
`scripts/lib/tabbit.mjs` 与其默认签名常量由上游提供，不在 overlay 中复制。
安装只覆盖上述代码，**不启动服务、浏览器或安装依赖**。

源文件预检在任何目标写入和 Git 操作之前执行；缺任一源文件即非零退出。
`--dry-run` 不创建目录、不写文件、不调用 Git 或网络，输出中的 API key 已脱敏。
`--skip-clone` 跳过 clone/pull，仅安装 overlay 与配置；没有 Git/网络子进程。
非空、非 Git 目录需要显式 `--skip-clone`。

已有 `.env` 的凭证、cookie、端口、账号键和状态路径保留，只追加缺项。
首次覆盖前保存 `*.upstream-bak`；重装保持首次备份，不覆盖成 overlay。
状态账本、`.tmp`、损坏备份及无关文件保持原样，也不随 overlay 分发。

可在 `.env` 中设置：

| 配置 | 语义 | 默认 |
|---|---|---|
| `TABBIT_ACCOUNT_KEY` | 用户显式设置的非秘密账号标签；切换账号时须区分，不是自动身份识别 | `default` |
| `TABBIT_BRAIN_SESSION_MAP_PATH` | 映射账本路径；自定义值保留 | 网关根目录的 `state/brain-session-map.json` |

配置读取优先使用 `.env` 中的非空值，其次 shell 环境变量，最后默认值。
默认状态路径用 `fileURLToPath` 解析模块路径，支持 Windows 盘符、中文与空格。

隔离安装器回归（目标与 HOME 均为临时 fixture，不启动网关）：

```bash
node --test tools/test-gateway-install.mjs
```

### 修改 `src/server.mjs`

cookie 刷新逻辑改为两段：

```
快路径：调试端口上已有实例（你自己带端口启动的）→ 直接读
慢路径：起一个短命 headless 实例 → 读到 token → 立刻杀掉
```

**失败不阻断服务**——cookie 还有效时模型照样能调，只是续期暂时不可用。

---

## 安装后

```bash
cd <安装目录>
npm install            # 装依赖（如果没有 node_modules）
node src/server.mjs    # 启动，验证能否自动取 cookie
```

日志里看到这段就成功了：

```
[server] cookie 自动刷新失败: fetch failed；改用短命 headless 实例取 cookie…
[server] [headless] 启动短命 headless 实例取 cookie（端口 9222）
[server] [headless] 已结束短命 headless 实例
[server] cookie 已自动刷新 (5 个, 长度 1370) [ephemeral]
```

> **看到「cookie 里没有 token」= 你的 Tabbit 没登录。** 先打开 Tabbit 登录一次。
> cookie 是从你自己的浏览器会话里读的，没有账号就没有 cookie。

---

## cookie 续期：什么时候能用、什么时候不行

这是使用中最容易困惑的一点，所以单列出来。

**续期不是只在 cookie 过期时发生**——它是定期 + 按需触发的：

| 触发时机 | 说明 |
|---|---|
| 网关启动时 | 每次 |
| 定时刷新 | **每 6 小时**（`COOKIE_REFRESH_MINUTES`，默认 360） |
| 遇到鉴权错误 | 401 / 403 / 492 |

**每次触发时，网关按这个顺序判定**：

| 那一刻的状态 | 结果 | 说明 |
|---|---|---|
| Tabbit **没开** | ✅ **短命 headless 实例** | 起一个无窗口实例取 cookie，取完立刻杀 |
| Tabbit **开着、带调试端口** | ✅ **直接复用** | 不起新实例，从现有 CDP 读 |
| Tabbit **开着、无调试端口** | ⚠️ **跳过本次** | 见下 |

### 为什么第三种跳过了

Chromium 是**单实例**的。如果再用同一个 profile 起一个 headless 实例，新进程会被
**转交给已经在运行的那个实例**——调试端口永远不会出现。实测要白等满 45 秒才超时
（早期版本就是这样），期间用户什么也得不到。

所以现在的行为是**立刻如实返回**，不浪费时间：

```
[headless] Tabbit 已在运行（12 个进程）但没有调试端口，无法从中读取 cookie；
           不尝试新建实例（单实例会转交给已有实例，端口不会出现）。
[server] 短命 headless 取 cookie 失败 (browser-running-without-cdp)，本次沿用旧 cookie
```

### 跳过、恢复与验证边界

跳过时沿用已有 cookie；它仍有效则模型可调用。读取 cookie 不会自动注册或重新登录，
也不保证恢复服务端已失效的 token。普通 Tabbit 开着且无 CDP 时，请保存工作并退出，
然后重试委派，或调用 `POST /admin/refresh-cookie`。缺少登录态时先重新登录再退出。
管理端点可能在读取失败后仍返回旧 cookie 的 `ok: true`；检查 `lastCookieRefresh`
是否更新，并以实际模型请求确认恢复。

当前短命读取路径不使用 `TABBIT_KILL_EXISTING_BROWSER`，设为 1 不会让它重启用户窗口。
本项目也没有分发 `start-tabbit-debug.cmd`；不要依赖这两个入口完成恢复。
清理使用启动前后 PID 差集：已有用户窗口保留场景已测，读取期间用户新开实例的并发
归属仍未充分验证。短命实例也会短暂占用 profile；读取期间先不要启动另一个实例。

---

## 平台支持

**仅 Windows。** `detect.mjs` 读 Windows 注册表，`cdp.mjs` 用 `tasklist` / `taskkill`
管理浏览器进程。macOS / Linux 需要移植这两处。

---

## 安全提示

- **`.env` 含登录凭证**（`TABBIT_COOKIE`），已被 `.gitignore` 排除，**不要提交**。
- cookie 由服务启动时自动写入，不需要手工填。
- 网关只监听 `127.0.0.1`，不要暴露到公网。
