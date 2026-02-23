# MCP → CLI Adapter Layer (通用接管层) 设计

本文档说明如何将现有 Unreal MCP Server 的能力，以**通用适配层**方式暴露为 CLI，而不破坏现有 MCP 能力。

## 结论

可以做，而且推荐用“**双入口 + 单内核**”模式：

- 保留 MCP（`stdio` / tool registry / schema）作为协议入口。
- 新增 CLI 入口作为接管层。
- 两个入口都调用同一套执行内核（Tool Registry + Consolidated Handlers）。

这样做可以避免重写 35+ 工具、避免协议耦合，并允许 Agent Skills 在不依赖 MCP 客户端的情况下直接调用命令行。

---

## 当前实现状态

已在 `src/cli.ts` 提供 CLI 接管层最小实现：

- `tools list`
- `tool describe <name>`
- `tool run <name> --args <json>`
- `tool run <name> --args-file <path>`

该实现通过 in-memory MCP client/server 复用现有 registry 与 handler 分发路径，避免重复实现工具逻辑。

---

## 目标

1. 提供统一命令：`ue-cli tool <tool-name> --args '<json>'`
2. 保持与 MCP 工具语义一致（同参数、同输出结构）
3. 最小化改动范围：不改变 C++ Bridge 协议，不绕过 registry
4. 保留对未来协议的扩展能力（HTTP / gRPC / 自定义 skill transport）

---

## 总体架构

```text
                 +----------------------+
                 |   MCP Client (stdio) |
                 +----------+-----------+
                            |
                    MCP Server Transport
                            |
+---------------------------v----------------------------+
|              Tool Execution Core (shared)             |
|  - consolidated-tool-definitions                      |
|  - tool registry / validation / response schemas      |
|  - consolidated handlers                              |
+---------------------------+----------------------------+
                            |
                  executeAutomationRequest
                            |
                 +----------v-----------+
                 | UE Automation Bridge |
                 +----------------------+

                 +----------------------+
                 |   CLI Adapter Layer  |
                 |  ue-cli tool ...     |
                 +----------+-----------+
                            |
                 (调用同一 Tool Execution Core)
```

---

## 关键设计原则

### 1) Single Source of Truth

CLI 不自建第二套参数模型；直接复用 consolidated tool definitions。

### 2) Registry-First

CLI 不直接调用具体 handler，而是通过同一注册/分发路径执行，保证行为一致。

### 3) Output Compatibility

默认输出 JSON，字段与 MCP tool call result 对齐；可额外提供 `--format table` 仅用于人类阅读。

### 4) Error Contract

CLI 退出码与错误类型绑定：

- `0`: 成功
- `2`: 参数校验错误
- `3`: Unreal/Bridge 不可达
- `4`: 工具执行失败
- `5`: 系统错误

---

## 最小落地方案（MVP）

### 命令形态

```bash
ue-cli tools list
ue-cli tool describe manage_asset
ue-cli tool run manage_asset --args '{"action":"list","path":"/Game"}'
```

### MVP 范围

- 工具发现：`list`, `describe`
- 工具执行：`run <tool> --args <json>`
- 输出格式：`json`（默认）
- 连接策略：沿用当前 bridge 配置（环境变量）

---

## 分阶段迁移

### Phase 1: Adapter Bootstrapping

- 新建 CLI 解析层（仅参数解析与格式化）
- 提取可复用的 Tool Execution API（供 MCP 与 CLI 共同调用）

### Phase 2: Compatibility Hardening

- 对齐 MCP 与 CLI 的响应结构
- 添加快照测试（同输入下 MCP/CLI 输出字段一致）

### Phase 3: Skill-Friendly UX

- 增加 `--compact` / `--jsonl` / `--timeout`
- 增加批处理输入：`--args-file`

### Phase 4: Multi-Transport Extension

- 在不改工具内核的前提下新增 HTTP/IPC transport

---

## 对 Agent Skills 的价值

- 无需 MCP 客户端即可触发工具
- 在 CI / 自动化脚本中更容易集成
- 更适合“技能脚本化编排”（shell + JSON 管道）

---

## 风险与规避

1. **参数漂移风险**：CLI 与 MCP 参数不一致  
   - 规避：CLI 直接复用 consolidated schema

2. **执行路径分叉风险**：CLI 与 MCP 行为不同  
   - 规避：统一入口到 registry + shared executor

3. **日志污染风险**：影响机器读取结果  
   - 规避：stdout 仅输出结果 JSON，日志写 stderr

---

## 推荐决策

建议将目标定义为：

> “把 MCP 架构改造成**可被 CLI 接管的通用执行内核**，而不是替换掉 MCP。”

即：**MCP 是协议层，CLI 是接入层，工具执行内核保持统一**。
