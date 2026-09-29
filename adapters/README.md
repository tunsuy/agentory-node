# 仓内 RuntimeAdapter（ADR-004）

> Host（`apps/node`）编排；**每个 runtime 一个目录**。一期只接受仓内 PR，不支持用户机器动态装第三方包。  
> **开源面**：公开仓 [`tunsuy/agentory-node`](https://github.com/tunsuy/agentory-node)（Apache-2.0）= Host + contract + adapters；控制面仍在 private 产品仓。

## 目录

| 路径 | 包名 | 说明 |
|------|------|------|
| `packages/runtime-contract` | `@agentoryhq/runtime-contract` | manifest / capability / `RuntimeAdapter` 接口（`adapter_api = 1`） |
| `adapters/cursor` | `@agentoryhq/adapter-cursor` | 参考实现：detect · discoverConfig · applyAlign · indexSessions · readTranscript |
| `adapters/claude-code` | `@agentoryhq/adapter-claude-code` | detect · discoverConfig · applyAlign（项目 `.mcp.json` + skills 清单） |

## 新增一个 adapter（仓内 PR）

1. 复制 `adapters/claude-code` 为 `adapters/<runtime-id>/`，改 `package.json` 名称为 `@agentoryhq/adapter-<id>`。
2. 实现 `RuntimeAdapter`：至少 `detect`；按能力声明实现 `discoverConfig` / `applyAlign` / `indexSessions` / `readTranscript`。
3. 在 `apps/node/src/registry.ts` 的 `builtinAdapters` 注册。
4. 根 `package.json` workspaces 已含 `adapters/*`；把新包加入 root `build` / `pack:node-cli` 链（与 cursor / claude-code 同级）。
5. 单测：fixture 目录 + 断言发现/写回；禁止放宽扫盘面。
6. 更新本 README 表格一行。
7. 同步导出公开仓：`make oss-node-export`（见 `scripts/export-agentory-node-oss.py`）。

## 禁止

- 默认无鉴权全盘扫盘 / SSH 接管（见 `docs/harness/invariants.md`）。
- 密钥、token 明文写入日志或 commit。
- 把 rulesync / add-mcp 等同步产品挂成 Host 内核依赖。
- 在 adapter 内另立期望态 SSOT（配置权威在控制面；只执行已确认 align）。

## 参考

- ADR：`docs/decisions/ADR-004-runtime-adapter-oss.md`
- Feature：`docs/features/node-oss-release/` · `docs/features/runtime-adapter-extract/`
- 贡献指南（公开仓）：`docs/features/node-oss-release/oss/CONTRIBUTING.md`
