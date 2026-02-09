# Memory + Compaction 流程图（Pomelobot）

本文提供端到端流程图，覆盖：
- 在线消息处理路径（含 memory flush 与 compaction）
- 退出/重启路径（含 K8s preStop + SIGTERM 的关机保护）

---

## 1. 在线处理主流程

```mermaid
flowchart TD
    A["用户消息 (CLI / DingTalk)"] --> B["解析会话 Scope (main / group / direct)"]
    B --> C["加载或创建 Session"]
    C --> D["更新 Token 计数器"]

    D --> E{"达到 flush 阈值? (>= 90%)"}
    E -- "Yes" --> F["Memory Flush (强制 memory_save)"]
    E -- "No" --> G
    F --> G{"达到 compaction 阈值? (>= auto_compact_threshold)"}
    D --> G

    G -- "Yes" --> H["Compaction (摘要旧消息 + 保留最近消息)"]
    G -- "No" --> I["执行 Agent 推理"]
    H --> I

    I --> J["按需调用 memory_search"]
    J --> K["检索 memory_chunks (FTS / Vector / Hybrid)"]
    J --> L["检索 dingtalk_session_events (会话热日志)"]
    J --> M["PG 不可用时回退文件 keyword 检索"]

    I --> N["持久化会话事件 (user / assistant / summary)"]
    N --> L

    I --> O["持久化会话状态 (messageHistory + token 计数)"]
    O --> P["PG dingtalk_sessions"]

    F --> Q["写入记忆文件 (daily / long-term)"]
    Q --> R["增量索引同步"]
    R --> K

    O --> S["返回回复给用户"]
```

---

## 2. 退出/重启保护流程

```mermaid
flowchart TD
    A["Pod 终止 / Ctrl+C"] --> B["K8s preStop 或系统信号触发 SIGTERM"]
    B --> C["DingTalk shutdown handler"]
    C --> D["等待会话处理队列清空 (drain + timeout)"]
    D --> E["对活跃 Session 执行 shutdown memory flush"]
    E --> F["持久化 Session 到 dingtalk_sessions"]
    F --> G["关闭 SessionStore / MCP 等资源"]
    G --> H["进程退出"]
```

补充说明：
- `SIGINT/SIGTERM` 可以触发上述保护流程。
- `SIGKILL` 无法被进程捕获，无法执行 flush（系统行为）。
