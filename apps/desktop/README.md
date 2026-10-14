# CCR Desktop（可选 Tauri 管理客户端）

CCR Desktop 是现有 CCR gateway 的管理伴侣，而不是独占 sidecar。它加载 gateway 提供的同一份 Web UI，并提供 native 托盘菜单。浏览器、CLI、server 不需要为桌面版修改。

## 当前功能

- 单实例；再次启动只唤起原窗口，不创建第二个 desktop/gateway。
- 左击托盘只打开菜单；`Open CCR UI` 单独打开窗口，关闭窗口隐藏到托盘。
- 托盘显示全局 `Router.default`（checkbox 标示当前项）、provider/model 列表、当前 provider 的 quota 信息或明确的不可用警告。
- 每 30 秒、手动 `Refresh`、成功切换后刷新菜单和 tooltip，不重复创建 tray。
- 模型切换只修改 `Router.default`。**模型族配置、think/background 等场景路由仍可能覆盖全局 default**；有模型族配置时菜单会明确提示。
- 主列表最多显示 15 个 provider，每个 provider 默认最多 12 个 model；超限显示 `More in Web UI…`。当前 default 对应的 provider/model 即使超限也保留（最多额外各一项）。
- 离线时保留最后已知列表并禁用模型切换；status 行显示连接/切换失败，quota 不伪造为零。连接恢复后 `Refresh` 自动打开 Web UI。quota 摘要不是系统通知，通知功能尚未实现。

## 生命周期与安全边界

1. 默认先连接本地 gateway。短暂重试后，如果端口已经 LISTEN（包括非 CCR 服务、hung gateway 或鉴权失败），只显示 offline/help，**不会抢占端口或停止任何进程**。
2. 仅在 TCP 返回 connection refused，且本地 CCR 配置与连接端口匹配时，才尝试执行已安装的 `ccr start`。`CCR_BIN` 必须指向可执行文件；其次从 `PATH` 和常见 npm global 目录寻找。启动环境把 executable 的父目录和常见 Node bin 目录加到 `PATH`，stdout/stderr 使用 null，不保留无人消费的 pipes。
3. 启动失败显示本地帮助页而非白屏。菜单中的连接设置错误需要修正后重启 **desktop**；`Refresh` 不重新读取环境/配置。
4. **`Quit Desktop (gateway stays running)` 只停止桌面轮询并退出 UI。无论 gateway 是原来就在运行，还是本客户端启动的，都故意继续运行，不 kill child，不读 PID 文件杀进程，不调用 `ccr stop`。** 这样退出桌面不打断其他客户端正在路由的 LLM 请求。已退出的 launcher 用 `try_wait` 回收；仍运行的 gateway 不等待、不杀。
5. 只连接 `http://127.0.0.1:<port>`，Rust admin transport 禁用 proxy 和 redirect，凭据不会转发给远程主机。外部 Web UI 没有任何 Tauri native permission，也没有 shell plugin / remote capability。内置帮助页使用严格 CSP，无 script、网络连接或内联样式。
6. Rust 托盘带 `X-API-Key` 调 admin API。Web UI 仍使用原有自己的鉴权流程；Rust 不把 key 注入网页、URL 或日志。

**限制**：现有 `/api/config` 只支持完整 config 写入。托盘先读最新 raw config，再只改 default、保存并 readback 校验；这不是原子 PATCH，仍可能与同时打开的 Web UI 保存操作产生竞争。避免同时在两个客户端编辑配置。

## 安装前提与环境

Node.js、CCR、系统 WebView **不打进 app**，须另行安装。Node/CCR 使用项目现有支持版本；桌面开发当前依赖要求 **Rust 1.90+**（本机验证版本 1.99.0）。

| 环境变量 | 行为 |
|---|---|
| `CCR_CONFIG_DIR` | 配置目录，读取其 `config.json`；默认 `~/.claude-code-router` |
| `CCR_DESKTOP_PORT` | 仅桌面的 loopback 连接端口；优先于 config `PORT`，默认 3456。若与 CLI 实际端口不同，拒绝自动启动 |
| `CCR_DESKTOP_API_KEY` | 优先于 config `APIKEY`；空字符串表示不发送 key |
| `CCR_BIN` | 可选的 CCR executable 完整路径，尤其适合 GUI 没有 terminal PATH 的情况 |
| `SERVICE_PORT` | CCR server 自身的 runtime override；自动启动安全检查会考虑它。桌面仍用 config `PORT` 或 `CCR_DESKTOP_PORT` |

Config 支持 JSON5；端口/key 中的 `$NAME`、`${NAME}` 使用 desktop 进程环境展开。未定义变量或无效端口不启动连接。GUI 从 Finder 等启动时通常不继承 shell 的自定义变量，请确保 app 启动环境可用，或在本地 config 中配置。

示例（已有安装，不修改 Router）：

```sh
source "$HOME/.cargo/env"
export CCR_BIN=/opt/homebrew/bin/ccr
cd apps/desktop/src-tauri
cargo tauri dev
```

## 构建、检查、图标

从 repo root 执行：

```sh
source "$HOME/.cargo/env"
cargo install tauri-cli --version '^2' --locked
cd apps/desktop/src-tauri
cargo fmt --check
cargo check
cargo test
cargo clippy --all-targets -- -D warnings
# macOS 未签名 .app；只打包，不启动 app，不连接 live gateway
cargo tauri build --bundles app --no-sign
```

macOS 输出：`apps/desktop/src-tauri/target/release/bundle/macos/CCR Desktop.app`。正式分发仍需独立完成签名、公证与安装验证，当前没有 auto-updater。Windows/Linux 的打包与 native tray/WebView 行为尚未在本次验证，不能视为已通过跨平台验收。

客户端图标使用用户提供的橙色圆角路由图案，原始 RGBA PNG 保存在 `icons/source.png`（1254×1254，保留透明边缘）。包含 PNG、Windows Appx logo、ICNS、ICO；可用 `cargo tauri icon icons/source.png` 再生成（命令还会生成本项目暂未使用的 mobile assets）。

### 本次实际验证（2026-10-14）

- macOS arm64 / Rust 1.99.0 / Tauri CLI 2.12.2。
- `cargo fmt --check`、`cargo check`、`cargo test`（26/26）、`cargo clippy --all-targets -- -D warnings`；测试全用独立 ephemeral loopback endpoints/pure settings，无 live config 修改。
- 未签名 `.app` 构建成功，bundle 输出 **3.56 MiB**（仅 arm64 desktop 壳，不包含 Node/CCR/runtime，不能外推为 universal/DMG/installer 大小）。最终产物大小以实际 build 输出为准。
- 图标 `icon.icns`、`icon.ico` 文件格式已验证。签名、公证、Windows/Linux、真实 gateway spawn→exit 与 native menu 手测不在上述结果内；不得为验证而停止或重启正在使用的 CCR。
