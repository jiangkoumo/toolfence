# ToolFence 项目约束

安全代理项目，改动必须小而明确，且要有拒绝路径（denial-path）测试。

## 提交前必跑

```bash
npm run verify        # typecheck + 覆盖阈值测试 + build + demo + 打包冒烟 + pack dry-run
npm audit --omit=dev  # 生产依赖审计
```

发布前再加 `npm run release:check`。

## 安全与信任边界

- 测试要覆盖受影响路径中的：成功、拒绝、畸形输入、取消、超时、断开。
- 改 proxy/CLI 时，stdout 只保留 MCP JSON-RPC，不打印调试信息。
- 不记录原始工具参数、命令参数、审批 token、原始上游结果（审计只记 hash / operation / resources）。
- fail-closed 是核心不变式：deny / timeout / 取消 一律「未转发」，不留可事后授权的幽灵审批。
- 漏洞走 SECURITY.md 私报，不开公开 issue。

## 发布与版本

- 只通过 GitHub Actions `publish.yml` 可信发布，不加 npm 长令牌。
- 保留 `contentPolicy: "dual-use"` 和根目录 `DISCLOSURE`（npm 声明为永久）。
- 发布失败不要复用或移动 tag：修好后升版本号再发。

## 跨仓库联合开发（AgentTape）

- `docs/AGENTTAPE_TOOLFENCE_ALIGNMENT.md` 必须与 AgentTape 仓库（`~/Documents/ChatGPT/#`）的同名文件字节一致，改动要两边镜像。
- 每轮只改一个「主开发项目」，另一个固定在已记录的 commit/version 作为伴随观察器。
- 改行为或发布保证时，同步更新 README、TESTING、CHANGELOG。
