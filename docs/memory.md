# Memory 机制说明（Pomelobot）

本文参考 OpenClaw Memory 概念文档结构，结合当前仓库实现，说明 Pomelobot 的记忆机制、检索机制、会话机制与运维要点。

参考：
- [OpenClaw Memory](https://docs.openclaw.ai/zh-CN/concepts/memory)
- [OpenClaw Compaction](https://docs.openclaw.ai/zh-CN/concepts/compaction)
- [Memory + Compaction 流程图](./architecture-memory-compaction.md)

---

## 1. 什么是 Memory

在本项目里，Memory 不是“把整段历史对话一直塞进上下文”，而是两层机制协同：

1. 会话态记忆（短期）
- DingTalk 模式把 `messageHistory` 持久化到 PG `dingtalk_sessions`，用于重启后恢复会话。

2. 知识型记忆（长期）
- 通过 `memory_save` 写入 Markdown 文件（`daily` / `long-term`），并建立 PG 增量索引。
- 回答历史问题时通过 `memory_search` 按需检索，不依赖静态 system prompt 全量注入。

---

## 2. 记忆文件与存储结构

### 2.1 文件层（可读可审计）

- 主会话长期记忆：`workspace/MEMORY.md`
- 主会话每日记忆：`workspace/memory/YYYY-MM-DD.md`
- 隔离 scope 长期记忆：`workspace/memory/scopes/<scope>/LONG_TERM.md`
- 隔离 scope 每日记忆：`workspace/memory/scopes/<scope>/YYYY-MM-DD.md`
- 会话 transcript：`workspace/memory/scopes/<scope>/transcripts/YYYY-MM-DD.md`

### 2.2 数据库层（检索与恢复）

Schema 默认：`pomelobot_memory`

- `memory_files`：索引文件元数据（mtime/size/hash）
- `memory_chunks`：分块内容、FTS、可选向量 embedding
- `embedding_cache`：embedding 缓存
- `dingtalk_sessions`：会话状态（messageHistory + token 计数）
- `dingtalk_session_events`：会话事件热日志（user/assistant/summary）

---

## 3. 什么时候会写入记忆

### 3.1 显式保存（强语义）

Agent 调用 `memory_save` 时：
- `target=daily` -> 当日记忆文件
- `target=long-term` -> 长期记忆文件

写入后会触发单文件增量索引。

### 3.2 压缩前自动 flush（防丢关键事实）

当会话 token 接近阈值时，系统先触发 memory flush：
- 注入强约束提示，要求模型调用 `memory_save`
- 摘要保存后返回 `NO_REPLY`
- 再进入 compaction

### 3.3 DingTalk 会话热日志

每条 user/assistant 消息会优先写入 `dingtalk_session_events`。
- PG 不可用时才降级写 transcript 文件。
- compaction 完成后会把 `summary` 也记为事件。

### 3.4 进程退出（SIGINT/SIGTERM）

DingTalk 进程在优雅退出时会：
1. 等待在途会话处理队列
2. 对活跃 session 尝试执行 shutdown flush
3. 持久化 session 状态

这一步用于减少容器重启时“最后几轮对话没落盘”的风险。

---

## 4. 记忆检索（memory_search）

### 4.1 当前统一检索入口

`memory_search` 现在是统一召回：
- `memory_chunks`（长期/每日/transcript 索引）
- `dingtalk_session_events`（会话热日志）

然后按配置模式排序返回。

### 4.2 触发条件（何时必须先 `memory_search`）

以下场景回答前应先检索，再作答：

- 问“之前做过什么、历史决策、偏好、待办、时间线、某人信息、某日期发生了什么”等历史事实问题。
- 用户出现回溯型问法，如“你还记得吗”“之前/上次/刚才”“今天/昨天”“我们是否聊过”等。

约束：

- 如果检索结果不足，必须明确说明“已检索但未找到足够信息”或“已检索但信息不足”。
- 禁止把猜测当成记忆事实。
- 当用户明确要求“记住/保存”时，应调用 `memory_save` 写入对应记忆层（`daily` / `long-term`）。

### 4.3 检索模式

`agent.memory.retrieval.mode`：

- `keyword`：ILIKE 关键词匹配
- `fts`：PostgreSQL 全文检索（`websearch_to_tsquery + ts_rank_cd`）
- `vector`：向量检索（cosine）
- `hybrid`：vector + fts 加权融合

会话热日志可通过以下配置控制是否参与：
- `include_session_events`
- `session_events_max_results`

### 4.4 降级路径

- PG 不可用：降级到文件系统逐行 keyword 检索
- pgvector/embedding 不可用：自动退回 FTS/keyword

---

## 5. 索引与同步策略

### 5.1 增量索引核心

- 启动：`syncIncremental(force=true)` 建立基线
- 保存：`memory_save` 后单文件强制索引
- transcript：append 后去抖同步（避免每条消息都强制重扫）
- 搜索前：按 `sync_on_search + sync_min_interval_ms` 触发条件同步
- 文件删除：全量同步时清理 PG 僵尸索引

### 5.2 向量相关

- 默认向量维度：`1536`
- 启动时尝试建 `vector` 扩展与 ivfflat 索引
- embedding 结果按 provider/model/hash 缓存
- 维度不匹配时会清理/跳过异常缓存

---

## 6. 会话隔离（Scope）

按 `agent.memory.session_isolation` 进行隔离：

- CLI：`main`
- DingTalk 私聊：默认 `main`（可设为 `direct_<senderId>`）
- DingTalk 群聊：`group_<conversationId>`

`memory_save`、`memory_search`、`dingtalk_sessions`、`dingtalk_session_events` 都遵循同一 scope，避免串会话记忆。

---

## 7. 关键配置项

```jsonc
{
  "agent": {
    "memory": {
      "backend": "pgsql",
      "pgsql": {
        "enabled": true,
        "connection_string": "",
        "host": "127.0.0.1",
        "port": 5432,
        "user": "pomelobot",
        "password": "***",
        "database": "pomelobot",
        "ssl": false,
        "schema": "pomelobot_memory"
      },
      "retrieval": {
        "mode": "hybrid",
        "max_results": 8,
        "min_score": 0.1,
        "sync_on_search": true,
        "sync_min_interval_ms": 20000,
        "hybrid_vector_weight": 0.6,
        "hybrid_fts_weight": 0.4,
        "hybrid_candidate_multiplier": 2,
        "include_session_events": true,
        "session_events_max_results": 6
      },
      "embedding": {
        "enabled": true,
        "cache_enabled": true,
        "providers": [
          {
            "provider": "openai",
            "base_url": "https://api.openai.com/v1",
            "model": "text-embedding-3-small",
            "api_key": "***",
            "timeout_ms": 15000
          }
        ]
      },
      "session_isolation": {
        "enabled": true,
        "direct_scope": "main",
        "group_scope_prefix": "group_"
      },
      "transcript": {
        "enabled": true,
        "max_chars_per_entry": 3000
      }
    }
  }
}
```

---

## 8. 与 OpenClaw 的差异与优劣

### 8.1 机制差异

1. 记忆来源与权威层
- OpenClaw：文档强调 Memory 文件（如 `MEMORY.md`）与可扩展记忆源，检索基于索引，不是每次全量读 md。
- Pomelobot：也是“文件 + 索引”模式，但额外引入了 `dingtalk_sessions` / `dingtalk_session_events` 的会话态数据库层。

2. 会话记忆能力
- OpenClaw：文档提到有 experimental session memory 方向。
- Pomelobot：DingTalk 侧已经把 session events 纳入统一检索入口，实用性更强。

3. 工具面
- OpenClaw：文档强调 `memory_search` / `memory_get` / `memory_save` 组合。
- Pomelobot：当前主要是 `memory_search` + `memory_save`，尚未提供标准化 `memory_get` 片段读取工具。

4. 同步策略
- OpenClaw：强调后台 watcher + debounce 的异步索引同步。
- Pomelobot：采用“启动基线 + 事件触发 + 检索前条件同步”的组合策略，更偏工程可控。

### 8.2 优劣对比

Pomelobot 的优势：
- 对 DingTalk 场景友好：重启恢复与会话热日志能力完整。
- PG FTS + Vector + Hybrid + session events 统一召回，检索面更广。
- 故障降级路径明确（PG/向量不可用可回退）。

Pomelobot 的短板：
- `memory_get` 缺失，无法像 OpenClaw 那样显式“按路径/片段二次读取”。
- 记忆治理（去重、冲突合并、TTL、质量评分）仍偏轻量。
- CLI 会话态仍是内存 checkpointer，重启后上下文连续性弱于 DingTalk。

OpenClaw 的优势（从文档设计看）：
- Memory/Compaction 概念体系完整，工具契约更标准化。
- 文件权威层 + 索引层边界清晰，便于长期治理。

OpenClaw 的潜在代价：
- 对接企业现有消息通道时，仍需额外补会话持久化与审计层。

---

## 9. 实践建议

1. 企业生产建议使用 `backend=pgsql + retrieval.mode=hybrid + include_session_events=true`。
2. 对高频会话，优先保障 PG 与 `vector` 扩展可用，减少降级触发。
3. 后续可补 `memory_get`，形成 “search -> get -> answer” 的两阶段检索链路。
