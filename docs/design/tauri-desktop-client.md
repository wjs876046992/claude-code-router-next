# CCR Tauri 桌面客户端：当前设计与边界

> 日期：2026-10-14。第二步实现中的管理伴侣设计；实际构建、验证和使用方式见 `apps/desktop/README.md`。
>
> **修正第一步生命周期**：desktop 不独占 gateway。退出 desktop 不能停止 gateway，否则会打断 agent 的 LLM 请求。此前的 `child.kill()` / PID 清理 / `ccr stop` 方案撤销，不作为验收目标。

## 1. 目标与复用边界

提供可选的 native 托盘客户端，快速切换全局 default、查看当前路由和 quota，直接加载现有 Web UI。server、CLI、React UI 与浏览器使用方式保持不变。

```
CCR Desktop
├─ 内置本地帮助页（strict CSP，无 native permission）
├─ readiness 后 navigate → http://127.0.0.1:<port>/ui/
│                            └─ 完全复用现有 Web UI / admin API
├─ native tray → Rust AdminClient → /api/config、/api/providers/quota
└─ connect-first；仅 refused port + known config 才尝试 ccr start

现有 browser / agent ──→ 同一个 gateway（desktop quit 后继续运行）
```

**不内嵌 Node/CCR runtime**。用户需要另行安装 Node 与 CCR。现有项目曾使用 native SQLite addon，当前也有 `node:sqlite` 路径；native addon 分发、SEA/pkg 资源加载与平台签名需要针对具体版本验证。不存在“pkg / SEA 必崩”的通用结论。此方案只是避免在本切片引入 runtime bundling、资源定位与 native ABI 支持成本，而不是证明其他打包方案不可行。

## 2. 模块与权限

| 文件 | 职责 |
|---|---|
| `apps/desktop/src-tauri/src/lib.rs` | 单实例、主窗口、初始化、hide-to-tray、只停 desktop 的退出路径 |
| `src/lifecycle.rs` | loopback endpoint、TCP 占用判定、config 匹配、安全 launcher/PATH、launcher 回收 |
| `src/settings.rs` | JSON5 / 环境变量 / API key / port discovery |
| `src/api.rs` | no-proxy/no-redirect authenticated admin API、snapshot、default 更新与 readback |
| `src/tray.rs` | 单一 tray、动态菜单/tooltip、串行 Controller、模型 payload、状态与 quota |
| `tauri.conf.json` / `capabilities/default.json` | 本地帮助页严格 CSP；permissions 为空；无 remote native grants |
| `apps/desktop/src/` | offline/help 页面，不是复制的 CCR React app |

- single-instance plugin 必须最先注册，重复启动只唤起原窗口。
- external CCR UI 只有 HTTP 能力，不授予 Tauri native permissions。不添加 shell plugin，不使用 `window.__TAURI__` 探测，不需要修改 React API baseUrl。
- Rust API key 不注入网页。Web UI 继续走原有鉴权 UI；environment/settings 错误不泄露 config 内容或 key。
- GUI setup 不进行 blocking network 等待。健康/启动/轮询在 async task，native menu 与 window 更新排到 main thread。

## 3. 生命周期：管理伴侣而非 owned sidecar

1. 先尝试 health，再短暂重试现有 gateway 的 readiness。
2. health 失败且 TCP port LISTEN 时（包括非 CCR 服务、hung server、鉴权错误），显示 offline，不 spawn、不 reclaim、不 kill。
3. 只有 TCP connection refused 且已知 config 的实际端口匹配，才寻找 `CCR_BIN` / PATH / 常见 npm global executable，再复查端口后执行 `ccr start`。把 bin 父目录和常见 Node bin 目录加入环境 PATH；stdio null 避免 pipe fill。
4. Webview 最初加载本地帮助页且隐藏；readiness 成功后 navigate 到 HTTP UI 再显示。失败则显示本地帮助页及 tray status，不留下白屏。
5. close 隐藏到 tray；左击 tray 只展开菜单，与 toggle 窗口不冲突；`Open CCR UI` 独立显示窗口。
6. `Quit Desktop (gateway stays running)` 停轮询并退出桌面。launcher 只 `try_wait` 回收已退出进程；不杀子进程、不动 PID file、不执行 stop/restart。已启动 gateway 故意持久存在。

自动启动是 best-effort，端口探测与 CLI bind 之间仍有系统竞争窗口；desktop 不负责终止任何其他监听者。真实 spawn→exit 测试必须选独立服务环境，不能拿用户正在运行的 gateway 验证。

## 4. 托盘第二步

- tray 创建一次；30s poll、`Refresh`、成功 switch 后 `set_menu` / `set_tooltip`。
- `CheckMenuItem` 表示当前全局 `Router.default`。model action ID 包含固定 provider/model payload，而不是刷新后会变义的索引；服务端 fresh GET 验证 target 仍可用，stale click 不会切到另一个模型。
- Controller 的 async Mutex 串行化 refresh/switch；switch 接受时增加 atomic epoch，忽略旧 refresh 结果；main-thread rendering 有 revision 检查避免倒序更新。
- 15 个 provider / 每 provider 12 个 model 为菜单默认上限；超限明确显示 `More in Web UI…`，当前 default 超限时仍保留。不静默丢弃第 16 个 provider / 第 13 个 model。
- connected、switching、API unavailable、switch failed 都有可见 status。snapshot 错误保留最后已知列表但禁用 switch，并提示 quota 数据可能过期。quota error 单独警告，不当作 zero usage。
- 多个 quota 行最多显示 5 行并提示完整 Web UI；tooltip 带当前 default 与 quota 摘要。
- switch 只修改 raw config 的 `Router.default`，保留其他字段和 secret placeholders；POST success + fresh GET readback 才算完成。

**路由范围**：只是全局 default。`Router.families` 与场景路由可能覆盖它，菜单明确提示。**竞争限制**：已有 config API 是 whole-config read/modify/write，不是原子 PATCH，与 Web UI 同时保存仍可能产生 lost update；当前切片没有宣称解决跨客户端并发写。

## 5. 打包与性能声明

本切片不签名、不公证、不实现 auto-update，不声称通过 Windows/Linux 验收。图标源为原创 RGBA 几何图形，使用 Tauri CLI 生成 PNG/ICNS/ICO/Appx 套件。

2026-10-14 macOS arm64 未签名 `.app` 首轮实际构建输出 **3.56 MiB**。这只是壳本体，不包括另行安装的 Node、CCR 与系统 WebView；不是 DMG、universal、Windows installer 或 Linux AppImage 的体积预测。启动时长、idle memory、frame rate 未测量，不记录性能达标结论。

此前设计里的 `7–15 MB` / 各平台安装包范围只是估算，已移除。也不使用 issue 的历史症状证明当前上游仍有同样缺陷；签名/公证/native addon 分发均需在正式发布时依据目标版本和 OS 再验证。

## 6. 验证与后续阶段

本次检查：`cargo fmt --check`、`cargo check`、`cargo test`、`cargo clippy --all-targets -- -D warnings`、`cargo tauri build --bundles app --no-sign`。测试使用 ephemeral loopback mock 与纯函数；不停止、不重启、不修改 live CCR Router。

- lifecycle：refused/occupied、remote 拒绝、config port 冲突、PATH resolver。
- tray：stable payload、坏 ID 拒绝、bounds/current outlier；完整 native menu event/GUI 时序仍需专门验收。
- backend：local settings、鉴权、snapshot/quota、raw config 保存、POST/verification failure、stale target 等独立 mock endpoint 测试。
- 最终集成 diff 需父代理安排独立 reviewer；上述编译/测试不替代 independent code review。

后续独立切片：系统 quota notification（含去重/阈值）、跨平台 UI/installer 验收、代码签名与公证、可选 updater、安全安装文档。正式发布仍按仓库 release/PR 政策，不因 `.app` 已构建而自行 merge 或发版。
