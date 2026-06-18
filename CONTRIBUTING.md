# 贡献指南 / Contributing

感谢你对 Claude Code Router 的兴趣！无论是修 bug、加功能、改文档还是提建议，都非常欢迎。本文档帮你快速上手。

Thank you for your interest in Claude Code Router! Bug fixes, features, docs, and ideas are all welcome.

## 提交 Issue

- **Bug**：请附上复现步骤、CCR 版本（`ccr -v`）、相关 provider、以及服务端日志（`~/.claude-code-router/logs/ccr-*.log`，注意先脱敏 API key）。
- **Feature**：先开 Issue 描述使用场景，避免直接提一个没人对齐的大 PR。

## 开发流程 / Development Workflow

本项目采用 **trunk-based**：所有改动通过 Pull Request 合入 `main`，没有 `dev` 分支。

1. **Fork & clone**
   ```bash
   git clone https://github.com/<your-fork>/claude-code-router-next.git
   cd claude-code-router-next
   pnpm install
   ```

2. **建 feature 分支**
   ```bash
   git checkout -b fix/short-description
   ```

3. **本地构建 & 验证**
   ```bash
   pnpm build          # 构建全部包
   ccr restart         # 重启服务加载新代码（不要用 stop + start）
   ```

4. **提交**：请使用 [Conventional Commits](https://www.conventionalcommits.org/) 格式，例如：
   - `fix: ...`、`feat: ...`、`docs: ...`、`chore: ...`
   - 参考 `git log --oneline` 的历史风格。

5. **开 PR 到 `main`**：CI 会自动跑全量构建，通过且 review 后即可合并。

## 代码规范

- **注释统一用英文**（项目硬性要求）。
- TypeScript，monorepo 由 pnpm workspace 管理；依赖关系为 `cli → server → shared`。
- 新功能请同步更新 `CHANGELOG.md` 和 README 的 changelog 表格（见 `CLAUDE.md` 的「Changelog 约定」）。
- 文档改动请写到 `docs/` 目录，不要新建散落的 md 文件。

## 分支保护

`main` 受分支保护：

- 必须通过 Pull Request 合入（不能直接 push）。
- 至少 1 个 approving review（PR 作者不能批准自己的 PR）。
- CI 必须通过，且分支需与 `main` 同步。
- 维护者（admin）可在必要时绕过以上规则，用于紧急修复。

## 发布

版本发布由维护者负责：bump 全部 `package.json` 版本号 → 跑 `pnpm release` → 打 git tag。贡献者无需关心发布流程。

---

有任何问题，欢迎在 Issue / Discussion 里提问。期待你的 PR！
