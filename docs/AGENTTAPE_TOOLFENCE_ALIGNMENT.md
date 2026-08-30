# AgentTape × ToolFence 双向联合开发对齐契约

alignmentVersion: 2
最后同步：2026-08-30

这是一份逻辑文档，在两个仓库中保留字节一致的镜像：

- AgentTape：`docs/AGENTTAPE_TOOLFENCE_ALIGNMENT.md`
- ToolFence：`docs/AGENTTAPE_TOOLFENCE_ALIGNMENT.md`

它定义双方共同遵守的角色、场景、证据和回流规则。AgentTape 侧的具体首次执行步骤见 `docs/TOOLFENCE_DOGFOODING.md`；本契约优先定义跨仓库不变量。

## 1. 联合开发模型

每一轮只能有一个“主开发项目”，另一个项目固定在已记录的 commit/version，作为“伴随观察器”。两边都接受验证，但不能在尚未归因时同时修改。

| 当前工作 | 主开发项目 | 伴随观察器 | 主要工作区 | 双向验证目标 |
| --- | --- | --- | --- | --- |
| 开发 AgentTape | AgentTape | ToolFence | AgentTape 仓库 | AgentTape 的捕获/检查/分叉/回归可用；ToolFence 的策略/审批/审计/脱敏不妨碍真实工作 |
| 开发 ToolFence | ToolFence | AgentTape | ToolFence 仓库 | ToolFence 的代理/Policy/Broker/结果处理可用；AgentTape 能记录、解释并沉淀真实失败 |
| 修改共同证据契约 | 先指定一边 | 另一边保持固定 | 主项目仓库 | 两边镜像文档、事件语义与回归边界保持一致 |

伴随观察器不是测试替身：

- 开发 AgentTape 时，受测 MCP 调用必须真的经过 ToolFence；不能只运行 ToolFence 单测。
- 开发 ToolFence 时，必须在启用 AgentTape Hook 的真实 Codex 任务中工作；不能只生成合成 tape。
- Codex 内置 Shell、Git 和文件工具可以被 AgentTape 捕获，但不会自动经过 ToolFence。只有 fenced MCP 调用才能证明 ToolFence 的执行路径。

## 2. 共同拓扑

~~~text
Active Codex project
  ├─ built-in tools
  │    └─ AgentTape hooks → capture evidence
  └─ fenced stdio MCP alias
       ├─ ToolFence → decision / approval / audit / result filter
       └─ upstream MCP
            └─ AgentTape hooks → host-side tool evidence
~~~

两边共同承认以下边界：

1. ToolFence 是 MCP 调用代理，不是 Codex 全局沙箱。
2. AgentTape 是证据捕获和 structural replay 工具，不是完整执行重放器。
3. Deny、审批超时和转发前的代理内部失败必须 fail closed，且不得产生上游执行。结果过滤或响应后审计失败也必须对客户端 fail closed，但上游可能已经执行，证据和归因不得写成“未执行”。
4. Structural fork 必须保持 0 model calls / 0 live tool calls。
5. 原始参数、原始结果、真实凭据、raw capture 和 audit 不进入公共提交。
6. Fixture 只可提供安全、可控的上游行为；由 SDK 直连 fixture 得到的结果不算真实 Codex 场景。

## 3. 共同运行记录

每轮生成唯一 `JOINT_RUN_ID`，建议格式：

~~~text
YYYYMMDD-<primary>-<scenario>-<attempt>
~~~

例如：`20260829-toolfence-approval-timeout-a1`。

本地证据表至少记录：

| 字段 | 含义 |
| --- | --- |
| `alignmentVersion` | 本契约版本 |
| `JOINT_RUN_ID` | 跨两边证据的唯一关联键 |
| primary / observer | 本轮主开发项目和伴随观察器 |
| primary commit | 本轮被修改代码的基线 commit |
| observer commit/version | 固定的伴随项目版本 |
| Codex / Node / OS | 宿主环境 |
| policy hash / MCP alias | 实际执行的 ToolFence 配置身份 |
| AgentTape tapeId/sessionId | Capture 身份 |
| ToolFence audit path/time window | 决策与结果证据范围 |
| proxyRunId / clientSessionId | ToolFence 进程轮次与客户端会话关联字段 |
| server / tool / requestId | 调用关联字段 |
| approvalId / resolution | 审批身份与 `allow-once` / `allow-session` / `deny` 结果 |
| dispatch | deny/timeout 的 `not-forwarded` 证据；allow 不在转发前预先声称成功 dispatch |
| expected / observed | 预期和实际结果 |
| upstream count / side effects | 是否真正执行以及副作用 |
| owner / severity | 问题归属和严重度 |
| regression / test command | 最小复现与验证结果 |

ToolFence 当前工作树会在 decision/result 中写入 `proxyRunId` 与 `clientSessionId`，并在审批 decision 中写入 `approvalId`、真实 `resolution`；deny/timeout 还会写入 `dispatch: not-forwarded`。这些字段是关联证据，不替代 `JOINT_RUN_ID`、独立 audit 文件和上游计数。读取旧版本 audit 时字段可能不存在，仍必须使用严格时间窗，不能只看 request ID。

## 4. 共用的五场景套件

这五个场景是双方共同的真实验证语言。主项目不同，关注重点不同；证据结构不变。

| # | 场景 | ToolFence 必须证明 | AgentTape 必须证明 |
| --- | --- | --- | --- |
| 1 | 策略拒绝 | 明确 deny 与 `not-forwarded`；无 result；无上游执行 | 真实 MCP 调用被记录为失败，边界和原因可检查 |
| 2 | Broker 审批超时 | ask 最终 fail closed；pending 清理；`deny` resolution 与 `not-forwarded`；无上游执行 | 超时/权限失败被记录，任务不永久悬挂 |
| 3 | Allow 后上游失败 | 有 allow、一次上游调用和结果摘要；错误语义不被吞掉 | MCP `isError` 或等价失败被正确标记 |
| 4 | 只读证据分诊 | `list_tapes` / `inspect_tape` / `fork_run` 均经 fenced alias 审计 | 找到真实 capture；分叉为 0 model / 0 live tool；不修改原证据 |
| 5 | 人工复核回归 | `save_regression` 只经 `allow-once` 放行；audit 保留 approval ID/resolution 并证明最终 allow/result | 只写一个受限路径文件；可提交 artifact 不含原始 tool input/output；脱敏和断言经复核；bundled CLI 通过 |

执行原则：

- 五个场景分别使用新 Codex 任务和新 `JOINT_RUN_ID`。
- 场景 1–3 每轮只发起一次目标调用，禁止静默重试或改用 direct endpoint。
- 场景 4 只能读和 structural fork。
- 场景 5 不得使用 session grant，不得覆盖已有回归。
- Full suite 用于首次对齐、信任边界/证据 Schema 变化和重要发布前；普通变更按第 5 节选择最小相关子集。

## 5. 变更与场景映射

| 变更类型 | 主项目 | 最小场景 |
| --- | --- | --- |
| AgentTape Hook、失败识别、redaction | AgentTape | 1、2、3、4 |
| AgentTape MCP 读工具、tape store、structural replay | AgentTape | 4 |
| AgentTape `save_regression`、assertion runner、bundled CLI | AgentTape | 4、5 |
| ToolFence normalizer、Policy、默认决定 | ToolFence | 1、4 |
| ToolFence Broker、取消、超时、session grant | ToolFence | 2、5 |
| ToolFence proxy lifecycle、result filter、audit | ToolFence | 1、2、3、4 |
| 任一方改变共同证据字段、MCP 工具 Schema 或发布接入方式 | 指定一方 | 1–5 全套 |
| 任一方仅改文案且不改变行为 | 对应项目 | 链接/镜像检查；无需伪造运行证据 |

最小场景不是唯一测试。主项目仍需运行自己的单元、集成、bundle 和发布检查；联合场景只补真实宿主与跨项目证据。

## 6. 每轮工作流

1. **基线**：记录两个仓库的 dirty state、commit/version 和现有本地证据；不清理用户文件。
2. **选择角色**：写明 primary、observer 和本轮所需场景。Observer 在归因完成前不得改代码。
3. **配置**：使用项目级 fenced alias、最小 Policy、独立 audit 文件和已构建 bundle。
4. **重启宿主**：修改 MCP 配置后重启 Codex，并在新任务确认实际工具来源。
5. **执行**：每个场景只做约定调用，保留 `JOINT_RUN_ID` 和开始/结束时间。
6. **双边核对**：对齐 ToolFence decision/result/upstream count 与 AgentTape event/failure/redaction。
7. **归因**：先写最小复现、期望、实际、owner 和 severity，再决定改哪一边。
8. **修复**：优先只改 primary；若证据确认 observer 独立缺陷，结束当前轮并以 observer 为新的 primary 开新轮。
9. **回归**：先跑主项目测试，再跑最小联合场景。只有共同契约变化才要求全套。
10. **提交复核**：raw runtime/audit/config 不提交；仅提交经过人工检查的代码、文档和最小 regression。

## 7. 问题归属

| 证据表现 | 默认归属 |
| --- | --- |
| deny/timeout 后上游仍执行，或未经脱敏的结果返回 | ToolFence |
| Policy 命中、审批理由、request/result 生命周期错误 | ToolFence |
| MCP `isError` 与 audit error 语义不一致 | ToolFence 候选；先保存原始协议形态 |
| Result filter 或响应后 audit 失败 | ToolFence；对客户端 fail closed，但标明上游可能已执行 |
| Hook 漏事件、事件乱序、失败标成成功、secret 未脱敏 | AgentTape |
| inspect/fork/save 越界、错误改写 source、离线断言错误 | AgentTape |
| direct endpoint 与 fenced endpoint 来源混淆、重启后配置未加载 | Codex 主机/配置 |
| Bundle 陈旧、fixture 端口占用、日志路径错误 | 测试环境 |

默认归属只是分诊起点。最终归属必须由最小复现和双边证据确认。

## 8. 双边完成条件

一次联合轮次完成时必须满足：

- 主项目的相关自动化测试通过。
- 所选真实场景在新 Codex 任务中完成，并有双边可关联证据。
- Deny/timeout 没有上游执行；allow 后失败只有预期的一次执行。
- 没有真实 secret、绝对本机路径、raw prompt/result、原始 tool input/output 或私有审计进入提交。
- Observer 未因猜测被顺手修改；若发现独立问题，已经单独建轮。
- 任何新增 `.tape` 都来自真实 capture，经过人工复核，并由 bundled CLI 通过。
- 结论写清“已证明”“未证明”和产品边界，不把一次本地验证扩大成全 Host/OS 支持声明。

## 9. 镜像同步规则

1. 两个仓库的本文件必须字节一致；没有“默认更权威”的一份。
2. 改动角色、证据字段、场景或完成条件时，提升 `alignmentVersion` 并在同一逻辑变更中更新两边。
3. 只改错字或链接可保留版本，但仍要同步两份。
4. 开始联合轮次前执行：

~~~bash
cmp <AGENTTAPE_ROOT>/docs/AGENTTAPE_TOOLFENCE_ALIGNMENT.md \
    <TOOLFENCE_ROOT>/docs/AGENTTAPE_TOOLFENCE_ALIGNMENT.md
~~~

5. `cmp` 非零时停止测试，先对齐文档。任何一边处于未提交状态时都要保留用户改动并人工合并，禁止用整文件覆盖解决冲突。
6. 两仓库无法原子提交时，使用相同 alignmentVersion 和互相引用的提交说明；第二边同步前不得宣称契约已经发布完成。

## 10. 隐私与停止条件

立即停止本轮并保留最小安全证据，如果发生：

- 真实凭据、个人数据或未脱敏 prompt 出现在 capture、audit、终端或 diff。
- 无法确认工具是否经过 fenced alias。
- Deny/timeout 后出现副作用。
- Codex 或 Broker 超时顺序与场景前提不符。
- AgentTape 和 ToolFence 证据无法用 `JOINT_RUN_ID`、工具和时间窗对齐。
- 为了让测试通过，需要同时修改两边但尚未证明两个独立缺陷。

停止不等于失败。先把现象归类为产品缺陷、主机/配置问题或测试环境问题，再以新的主项目和 `JOINT_RUN_ID` 继续。
