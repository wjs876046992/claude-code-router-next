# CCR Tauri 桌面客户端 调研与设计

> 真实意图：给 CCR 加一个可选的菜单栏桌面客户端，让用户不用开浏览器就能切 provider/模型、看用量/套餐、收 quota 通知。对标 magpie 的桌面体验，但 web UI 不变（web 优先，Tauri 是可选薄壳）。
> 日期：2026-10-14 / 状态：草案，可直接进入实现

## 1. 现状与接入点

### 数据流（改动前）

```
用户浏览器 ──HTTP──→ fastify server (127.0.0.1:3456)
                      ├─ /v1/messages    (LLM 路由，agent 用)
                      ├─ /api/config      (admin API，X-API-Key 鉴权)
                      ├─ /api/providers/* (health/quota)
                      ├─ /api/usage/*     (用量统计)
                      └─ /ui/             (@fastify/static serve 单文件 index.html 3.8MB)
```

UI 用 `vite-plugin-singlefile` 打成单 `index.html`，`base: './'`，全内联（无外部 chunk）。CLI start 用 `spawn("node", [cliPath, "start"], {detached:true})` 起 detached server 进程，写 PID 文件。

### 同类实现参考（项目内）

- **CLI start（`packages/cli/src/utils/index.ts:287`）**：已用 `spawn` detached 起 server——这正是 sidecar 的现成模式。
- **CLI restart（`index.ts:239`）**：`spawn("ccr", ["restart"], {detached:true})` 延迟重启——Tauri 托盘「重启 server」菜单可复用。
- **admin API 鉴权**：`X-API-Key` header（`packages/ui/src/lib/api.ts`），Tauri 壳调 API 时带同一个 key。
- **PID 文件**：`~/.claude-code-router/.claude-code-router.pid`——sidecar 退出清理可双保险。

### 要动的文件清单

| 文件 | 职责 | 改动类型 |
|---|---|---|
| `apps/desktop/`（新建）| Tauri 项目目录 | 新增 |
| `apps/desktop/src-tauri/Cargo.toml` | Rust 依赖（tauri + tray-icon + reqwest） | 新增 |
| `apps/desktop/src-tauri/tauri.conf.json` | Tauri 配置（externalBin=null, webview URL） | 新增 |
| `apps/desktop/src-tauri/src/main.rs` | Rust 壳：spawn ccr sidecar + webview load + 托盘 | 新增 |
| `apps/desktop/src-tauri/src/tray.rs` | 托盘菜单构建 + on_menu_event 调 admin API | 新增 |
| `packages/ui/src/lib/desktop.ts`（新建）| `isDesktop()` 检测 + 托盘相关 UI 条件渲染 | 新增（极薄） |
| `packages/ui/src/lib/api.ts` | Tauri 模式下 baseUrl 用绝对 URL | 微调（1 行） |
| `package.json`（root）| `desktop:dev` / `desktop:build` script | 新增 2 行 |

**零改动**：`packages/core/`（server 代码完全不动）、`packages/cli/`（CLI 命令不动）、`packages/shared/`。server 不感知客户端是浏览器还是 Tauri。

### 已知约束与坑

- **native addon 打包地狱**：better-sqlite3 是 native addon，官方推荐的 pkg 编译 Node sidecar **必崩**（vercel/pkg #837/#690，yao-pkg #275/#82 一手证据）。→ **决定不内嵌 node**。
- **macOS sidecar 签名坑**（Tauri #16211，v2.12.1 未修）：sidecar 被强制用 app entitlement 签名，受限 entitlement（associated-domains 等）致 AMFI kill（exit 137），codesign/notarize 全 pass 不报错。→ 避免 deep-link `domains` 配置。
- **sidecar 退出不自动 kill**（Tauri #14443 未合并）：Tauri 退出时 sidecar 成孤儿。→ Rust 侧手动 kill（复用 CCR PID 文件 + `ccr stop`）。
- **Windows Defender 误报**（#2486）：无代码签名易触发 `Trojan:Script/Wacatac.B!ml`。→ 建议配代码签名证书。

## 2. 外部调研

### 2.1 Tauri v2 sidecar（手动 spawn 路线）

官方 `externalBin` + `Command::new_sidecar` 路线坑多（签名/AppImage/NSIS，#8689/#15134/#16211）。**推荐手动 `std::process::Command` spawn**（`tauri-webui-packager` / `sqlui-native` 实战路线）：

```rust
use std::process::{Command, Stdio, Child};

// Tauri setup 里 spawn ccr server
let child: Child = Command::new("ccr")
    .arg("start")
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()?;
// 存到 Tauri State 里，退出时 child.kill()
```

来源：Tauri 官方 `develop/sidecar.mdx` + issue #14360/#14443；`sqlui-native`（`SIDECAR_PORT=0` 动态端口 + bundled_node fallback）；`forgedev` 架构文档（"Tauri's sidecar feature is designed for exactly this"）。

### 2.2 Tauri v2 托盘（TrayIconBuilder）

v1→v2 breaking：`SystemTray` → `TrayIconBuilder`。官方 `examples/api/src-tauri/src/tray.rs` 可直接抄：

```rust
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::menu::{Menu, MenuItem, Submenu};

let providers = MenuItem::with_id(app, "providers", "Providers", true, None::<&str>)?;
let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
let menu = Menu::with_items(app, &[&providers, &quit])?;

TrayIconBuilder::with_id("ccr-tray")
    .tooltip("CCR")
    .icon(app.default_window_icon().unwrap().clone())
    .menu(&menu)
    .on_menu_event(|app, event| match event.id.as_ref() {
        "quit" => { app.exit(0); }
        "providers" => { /* 唤起主窗口 */ }
        id if id.starts_with("model:") => { /* 调 admin API 切模型 */ }
        _ => {}
    })
    .build(app)?;
```

动态刷新：`app.tray_by_id("ccr-tray")` → `.set_menu()` / `.set_tooltip()` 更新当前模型。

### 2.3 webview 加载方式

**推荐方案 A**：Tauri webview 直接 `WebviewUrl::External("http://127.0.0.1:3456/ui/")` 加载 fastify serve 的同一份 UI。

- UI↔后端走 admin API（HTTP + X-API-Key），**不需要 `window.__TAURI__` IPC 注入**，规避 issue #5088。
- 浏览器版和 Tauri 版**完全共用后端 + UI**，零改动。
- `base: './'` 无需改（singlefile 全内联，无外部 chunk）。
- 来源：Tauri config reference + issue #5088（External URL 可加载但 IPC 未内置）。

**备选方案 B**：`frontendDist` 指 CCR 单文件 index.html，Tauri 直接加载本地文件。但需处理 IPC + CSP，比方案 A 复杂。

### 2.4 体积（一手数据）

| 平台 | 壳不内嵌 node（推荐） | 内嵌 node sidecar（不推荐） |
|---|---|---|
| macOS DMG universal | ~7-15 MB | +40-70 MB（node + better-sqlite3），~50-80 MB |
| Windows NSIS | ~5-10 MB (+WebView2) | 同上 |
| Linux AppImage | ~8-12 MB (+webkit2gtk) | 同上 |

对比：magpie（Go+Wails）macOS DMG 21.6 MB。壳不内嵌 node 时 **与 magpie 同级或更小**。来源：discussion #16021（27MB 含 Rust whisper.cpp 重计算）、#16154（delta updater 714KB vs 15.9MB）。

## 3. 方案对比与推荐

### 方案 A（推荐）：Tauri 壳 + webview load fastify UI + 手动 spawn ccr

```
Tauri 壳 (~7-15MB)
├─ Rust setup: spawn "ccr start"（用户全局装的 ccr，不内嵌 node）
├─ webview: WebviewUrl::External("http://127.0.0.1:3456/ui/")
│           ↑ 同一份 React UI，浏览器和 Tauri 共用
├─ 托盘菜单: 调 admin API（/api/config, /api/providers/quota）
│   ├─ 快速切 provider/模型（高频操作）
│   ├─ 当前 quota 状态（tooltip）
│   └─ Quit（kill sidecar + exit）
└─ 退出清理: child.kill() + ccr stop（PID 文件双保险）
```

- **改动面**：新增 `apps/desktop/`，server/UI 零改动
- **风险**：低（不碰 native addon、不碰 server 代码）
- **侵入度**：极低（独立 app 目录，不影响现有 monorepo 构建）
- **体积**：~7-15MB

### 方案 B（备选）：Tauri 壳 + frontendDist 加载本地 UI + 内嵌 SEA ccr

- 内嵌 Node SEA（单二进制 ccr），Tauri 加载本地 index.html
- **否决**：Node SEA experimental + better-sqlite3 native addon 必崩 + 体积 50-80MB + macOS 签名坑

### 为什么不用 Electron

- 150MB+（含 Chromium），完全违背"轻量"目标
- 唯一优势（纯 JS、API 全）不抵体积代价

### 为什么不用 Wails

- Wails v3 仍 beta，需把 fastify 迁到 Go（CCR 不会做）
- Tauri v2 stable，让 Node 逻辑留在 Node，Rust 壳只管窗口/托盘

## 4. 详细设计（方案 A）

### 数据流（改动后）

```
┌─────────────────────────────────────────────────┐
│ apps/desktop/ (Tauri 壳, ~7-15MB)                │
│                                                   │
│  Rust setup ──spawn──→ "ccr start" (用户全局装的)  │
│       │                           │               │
│       │ child 句柄存 State        │ detached       │
│       │                           ▼               │
│  webview ──load──→ http://127.0.0.1:3456/ui/     │
│       │                    │                      │
│       │                    │ 同一份 React UI      │
│  托盘菜单 ──HTTP──→ /api/config, /api/providers/*  │
│       │                    │                      │
│  退出 ──kill child──→ ccr stop (PID 文件双保险)    │
└────────────────────────────────────────────────────┘

浏览器用户（不变）──→ http://127.0.0.1:3456/ui/
```

### 文件级改动清单

1. **`apps/desktop/src-tauri/Cargo.toml`**：tauri 2.x + tray-icon + reqwest（调 admin API）
2. **`apps/desktop/src-tauri/tauri.conf.json`**：`build.devUrl` 指 vite dev server（dev 模式）；生产 webview 用 External URL
3. **`apps/desktop/src-tauri/src/main.rs`**：spawn ccr sidecar + 健康检查（轮询 /health）→ webview show + 托盘
4. **`apps/desktop/src-tauri/src/tray.rs`**：构建托盘菜单（provider/模型列表从 /api/config 拉），on_menu_event 调 /api/config POST 切模型
5. **`packages/ui/src/lib/desktop.ts`**：`isDesktop()` = `typeof window.__TAURI__ !== 'undefined'`，条件渲染托盘相关 UI
6. **`packages/ui/src/lib/api.ts`**：Tauri 模式下 baseUrl 从 `'/api'` 改为绝对 `http://127.0.0.1:3456/api`
7. **`package.json`（root）**：`"desktop:dev": "cd apps/desktop && cargo tauri dev"` / `"desktop:build": "cd apps/desktop && cargo tauri build"`

### 契约变更与兼容策略

- **admin API 不变**：托盘菜单调的是现有 `/api/config`（GET 拉列表、POST 切模型），无需新端点。
- **UI 不变**：`isDesktop()` 只控制是否显示「已在桌面运行」提示，不影响功能。
- **server 不变**：不感知客户端类型。
- **CLI 不变**：`ccr start` 行为不变，Tauri 只是又一个调它的入口。

### 分阶段实施

**第一步（最小可验证切片）**：
- `apps/desktop/` Tauri 项目骨架
- `main.rs`：spawn `ccr start` → 轮询 `/health` 200 → webview load `http://127.0.0.1:3456/ui/` → 窗口显示
- 退出时 `child.kill()`
- **验证**：`cargo tauri dev` 能弹出窗口显示 CCR UI，关窗口时 ccr 进程也被杀

**第二步**：托盘菜单
- `tray.rs`：从 `/api/config` 拉 provider 列表 → `MenuItem` 列表 → 点击调 POST `/api/config` 切模型
- tooltip 显示当前模型 + quota 状态
- 关窗口缩托盘（`ExitRequested` prevent_exit）

**第三步**：quota 通知
- 后台轮询 `/api/providers/quota` → 即将到限额时系统通知（Tauri notification API）

**第四步**：打包发布
- macOS .app + DMG（签名 + 公证）
- Windows NSIS（代码签名避免 Defender 误报）
- GitHub Releases 分发

### 测试策略

- **Rust 侧**：`cargo test`（sidecar spawn/kill 逻辑、托盘菜单构建）
- **集成**：`cargo tauri dev` 手测（启动 → UI 可见 → 切模型 → 退出无孤儿进程）
- **CI**：`cargo build --release`（跨平台编译验证）
- **不测**：Tauri webview 本身（系统组件）、签名/公证（需 Apple Developer 账号）

### 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| macOS sidecar 签名 #16211 | sidecar 被 AMFI kill | 避免 deep-link `domains`；只用 `allow-jit`；手动重签 |
| Windows Defender 误报 | 用户无法安装 | 配代码签名证书 |
| sidecar flaky | server 没起来 → UI 空白 | 健康检查超时后显示「ccr 启动失败」兜底页 |
| ccr 未全局安装 | Tauri 启动失败 | 启动时检测 `which ccr`，引导安装 |
| 退出孤儿进程 | ccr 残留 | child.kill() + PID 文件 + `ccr stop` 双保险 |

**回滚**：`apps/desktop/` 是独立目录，删除即回滚，不影响 server/CLI/UI。

## 5. 盲区与待拍板

### 未覆盖
- **代码签名证书**：macOS 需 Apple Developer ID，Windows 需 EV/Azure cert。是否有？
- **auto-update**：Tauri updater 集成未调研（第一步不做）。
- **Linux webview 依赖**：webkit2gtk 用户需自行装（`apt install libwebkit2gtk-4.1-dev`）。
- **Tauri 版本锁定**：设计基于 v2.12.x，后续 breaking 需跟进。

### 需要用户拍板
1. **代码签名**：macOS/Windows 是否有签名证书？没有的话首批只发未签名版（用户需手动允许）。
2. **仓库位置**：`apps/desktop/` 放 CCR monorepo 内（共享 pnpm workspace），还是独立仓库？推荐放 monorepo 内（共享 UI 构建）。
3. **第一步是否现在做**：我可以先搭 Tauri 骨架 + sidecar + webview（第一步），跑通 `cargo tauri dev` 弹窗显示 UI + 退出杀进程。做吗？
