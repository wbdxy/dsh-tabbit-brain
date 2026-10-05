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

### 必须你自己填的

| 参数 | 说明 | 默认 |
|---|---|---|
| ★ `--base-url <url>` | Tabbit 后端地址。**国内版 `https://web.tabbit.com`，国际版 `https://web.tabbit.ai`** | 国内版 |
| ★ `--api-key <key>` | 网关鉴权 key。自己定，**DSH 那侧的 `TABBIT_API_KEY` 必须与它一致** | `sk-tabbit-local` |
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

顺带消掉了与其它浏览器插件的启动竞争：我们不长期占用 profile，谁先启动都无所谓。

### 修改 `src/config.mjs`

`browserExe` 与 `browserUserDataDir` 改为自动探测（留空即探测，探测失败可手工指定）。

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

## 平台支持

**仅 Windows。** `detect.mjs` 读 Windows 注册表，`cdp.mjs` 用 `tasklist` / `taskkill`
管理浏览器进程。macOS / Linux 需要移植这两处。

---

## 安全提示

- **`.env` 含登录凭证**（`TABBIT_COOKIE`），已被 `.gitignore` 排除，**不要提交**。
- cookie 由服务启动时自动写入，不需要手工填。
- 网关只监听 `127.0.0.1`，不要暴露到公网。
