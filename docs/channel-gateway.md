# 渠道网关设计（Gateway + Adapter）

## 1. 目标

在不影响既有 DingTalk 能力的前提下，把“渠道接入”与“Agent 核心能力”解耦，形成可扩展的多渠道架构：

- 核心能力：Agent、Memory、Compaction、Cron、Exec 审批等
- 渠道能力：DingTalk / iOS / 飞书 / 安卓等协议适配

## 2. 当前实现

### 2.1 通用会话上下文

- 文件：`src/channels/context.ts`
- 能力：
  - `withChannelConversationContext`
  - `getChannelConversationContext`
  - `queueChannelReplyFile` / `consumeQueuedChannelReplyFiles`

### 2.2 网关抽象

- 文件：`src/channels/gateway/types.ts`
  - `ChannelAdapter`
  - `ChannelInboundMessage`
  - `ChannelOutboundMessage`
  - `ChannelCapabilities`
- 文件：`src/channels/gateway/service.ts`
  - `GatewayService.registerAdapter/unregisterAdapter`
  - `GatewayService.start/stop`
  - `GatewayService.dispatchInbound`（含幂等去重）
  - `GatewayService.sendProactive`

### 2.3 DingTalk Adapter（保持原行为）

- 文件：`src/channels/dingtalk/adapter.ts`
- 状态：已接入
  - `sendReply` -> `sendBySession`
  - `sendProactive` -> `sendProactiveMessage`
  - `handleInbound` -> 交给 `GatewayService`

### 2.4 iOS WebSocket Adapter（新增）

- 文件：`src/channels/ios/adapter.ts`
- 能力：
  - 内置 WS Server（`host/port/path` 可配置）
  - 支持 `hello` / `message` / `ping` 协议
  - `sendReply`：优先按连接回包，回退按会话/用户路由
  - `sendProactive`：支持 `conversation:<id>` / `user:<id>` / `connection:<id>`

### 2.5 Cron 渠道隔离（新增）

- 文件：`src/cron/runtime.ts`
- 能力：
  - 从单例升级为“按渠道注册 cron service”
  - `getCronService(channel?)` 按当前会话渠道取对应实例
- 文件：`src/cron/tools.ts`
  - `cron_job_add/update` 新增 `channel` 字段
  - 默认从当前会话推断 `channel + target`

### 2.6 统一服务端注册

- 文件：`src/server.ts`
- 变化：
  - `SUPPORTED_CHANNELS = dingtalk + ios`
  - 可通过 `CHANNELS=dingtalk,ios` 同时启动多渠道
  - 按渠道输出独立日志文件

## 3. 启动模型

### 3.1 单渠道

```bash
pnpm dingtalk
pnpm ios
```

### 3.2 统一服务端（多渠道入口）

```bash
pnpm run server
CHANNELS=dingtalk pnpm run server
CHANNELS=ios pnpm run server
CHANNELS=dingtalk,ios pnpm run server
```

## 4. 日志

统一服务端模式下：

- `logs/server-YYYY-MM-DD.log`：网关/服务端日志
- `logs/dingtalk-server-YYYY-MM-DD.log`：DingTalk 通道日志
- `logs/ios-server-YYYY-MM-DD.log`：iOS 通道日志

## 5. iOS 协议约定

客户端 -> 服务端：

- `hello`：会话初始化，可带 `token`
- `message`：用户消息，核心字段 `text`
- `ping`：心跳

服务端 -> 客户端：

- `hello_ack`
- `reply`
- `proactive`
- `dispatch_ack`

## 6. 新增渠道接入步骤（建议）

1. 新建 `src/channels/<channel>/adapter.ts` 并实现 `ChannelAdapter`
2. 解析渠道原始消息为 `ChannelInboundMessage`
3. 实现 `sendReply` / `sendProactive`
4. 在 `src/server.ts` 中注册并启动该 adapter
5. 在 `src/cron/runtime.ts` 注册该渠道 cron service
6. 补充渠道配置项与 README 文档

## 7. 约束与建议

- 幂等键建议优先使用渠道原生 message id，避免重放造成重复执行
- 非 DingTalk 渠道建议自定义 session scope 前缀，避免记忆串线
- 渠道扩展优先“新增 adapter”，避免修改核心 `handler` 业务逻辑
