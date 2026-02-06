# Memory 机制说明

本文说明当前项目的 Memory 机制，并基于 OpenClaw 的设计方向给出未来可扩展的能力清单。

## 当前实现（基于本仓库代码）

### 1) 存储形态与目录
- 工作区目录由配置 `agent.workspace` 决定（默认 `./workspace`）。
- 长期记忆：`workspace/MEMORY.md`
- 每日记忆：`workspace/memory/YYYY-MM-DD.md`
- 记忆都是 **纯 Markdown 文件**，写入是追加式。

### 2) 读取时机与上下文注入
- Agent 初始化时会加载记忆上下文并注入 system prompt：
  - `MEMORY.md`（若存在且非默认空模板）
  - 今日 `memory/YYYY-MM-DD.md`
  - 昨日 `memory/YYYY-MM-DD.md`
- 读取内容会被拼接成 “长期记忆 / 今日记忆 / 昨日记忆” 三段，作为系统提示的一部分。

### 3) 写入方式（memory_save）
- 通过工具 `memory_save` 写入记忆：
  - `target = daily`：写入当天的 `memory/YYYY-MM-DD.md`
  - `target = long-term`：写入 `MEMORY.md`
- 每条记忆带 `HH:MM:SS` 时间戳。

### 4) 搜索方式（memory_search）
- `memory_search` 使用 **关键词包含** 的方式搜索：
  - 扫描 `MEMORY.md`
  - 扫描 `memory/*.md`
- 返回命中的行号与文本片段（最多 20 条）。

### 5) 记忆 Flush（配合上下文压缩）
- 系统维护 token 估算与 flush 状态。
- 当接近自动压缩阈值时，会触发 **记忆 flush**：
  - 使用专门的系统/用户提示强制调用 `memory_save`
  - 将“用户主要问题、偏好、关键决策”写入 **每日记忆**
  - 成功后回 `NO_REPLY`（仅用于内部流程）
- CLI 与 DingTalk 处理流程都包含 “flush 先于 compaction”。

### 6) 当前限制
- 仅支持“关键词包含”检索，缺少语义搜索。
- 没有 `memory_get` 等按路径读取工具。
- 缺少记忆权限边界（如主会话/群聊的记忆隔离）。
- 没有记忆索引/缓存/去重与整理（curation）流程。

## 未来能力建议（参考 OpenClaw 设计）

以下能力可作为迭代方向，优先对齐 OpenClaw 已验证的机制，再结合本项目做裁剪：

### 1) 语义记忆检索（向量索引）
- 对 `MEMORY.md` 与 `memory/**/*.md` 做 Markdown 分块并建立向量索引。
- `memory_search` 返回结构化结果：片段文本、文件路径、行范围、得分、提供商/模型等。
- 不返回完整文件内容，仅返回片段（防止泄露与上下文膨胀）。
- 记忆文件变化时自动标记索引为 dirty，并进行增量/定时重建。

### 2) `memory_get` 工具
- 支持按路径 + 起始行 + 行数读取记忆文件片段。
- 仅允许读取 `MEMORY.md` / `memory/`，除非显式配置 `extraPaths` 放行。

### 3) 记忆来源扩展（extraPaths）
- 允许将项目知识库或运行日志（Markdown）纳入索引范围。

### 4) 插件化记忆系统
- 通过 “memory 插槽”启用/禁用/切换记忆后端（本地文件/远程索引/只读模式）。

### 5) 记忆安全与会话隔离
- 仅在主会话加载长期记忆，群聊/共享上下文不加载 `MEMORY.md`。
- 明确“记忆信任边界”与可见性规则。

### 6) 记忆整理与治理（可选扩展）
- 定期把“每日记忆”提炼为长期记忆（curation）。
- 记忆去重、冲突合并、过期清理（TTL）。
- 支持“重要性标注/标签”。

---

建议优先落地的能力：
1) `memory_get` + 结构化 `memory_search`
2) 语义检索与索引缓存
3) 主会话/群聊的记忆隔离
