# DeepAgents Bot

一个基于 DeepAgentsJS 的智能助手，参考了OpenClaw的设计理念。具有自主记忆和SKILLS编写/执行能力。

## 特性

- 🧠 **记忆系统**: 每日/长期记忆写入与检索，支持自动记忆 flush
- 🧹 **上下文压缩**: 自动/手动压缩对话历史，展示 token 使用情况
- 🛠️ **技能系统**: SKILL.md 定义技能，动态加载与子代理协作
- 💬 **交互模式**: CLI 对话 + DingTalk Stream 机器人模式
- 🧾 **命令执行**: 白名单命令执行，支持审批与超时/输出限制
- 📁 **文件读写**: 工作区文件系统读写，支撑记忆与技能存储

## 快速开始
  
### 1. 安装依赖

```bash
pnpm install
```

### 2. 配置

```bash
cp config-example.json config.json
# Qwen Code配置。这里建议让Agent使用CC等专业CLI工具生成代码。所谓术业有专攻，Agent本身并不是专业的Coding专家。
cp .qwen/config/settings_example.json ~/.qwen/settings.json
```

编辑 `config.json`：

```json
{   
    "openai": {   //兼容openai，后续考虑兼容ANTHROPIC接口
        "base_url": "",
        "model": "",
        "api_key": "",
        "max_retries": 3
    },
    "agent": {
        "workspace": "./workspace", // 工作区目录
        "skills_dir": "./workspace/skills", //SKILLS目录
        "recursion_limit": 50, // 递归限制, LangChain防止Agent无限循环的一道锁。可以适当提高
        "compaction": { // 上下文压缩配置
            "enabled": true, // 是否开启上下文压缩
            "auto_compact_threshold": 80000, // 自动压缩阈值
            "context_window": 128000, // 上下文窗口
            "reserve_tokens": 20000, // 保留token，防止压缩后丢失重要信息
            "max_history_share": 0.5 // 历史共享比例，0.5表示保留50%的历史记录
        }
    },
    "exec": {
        "enabled": true, //是否开启命令行模式
        "commandsFile": "./exec-commands.json", // 命令行白名单文件
        "defaultTimeoutMs": 30000, // 命令行超时时间
        "maxOutputLength": 50000, // 命令行输出最大长度
        "approvals": {
            "enabled": true // 是否允许执行命令行审批
        }
    },
    "dingtalk": {
        "enabled": false, //是否开启钉钉机器人
        "clientId": "", // 钉钉clientId
        "clientSecret": "", // 钉钉clientSecret
        "robotCode": "", // 钉钉robotCode
        "corpId": "", // 钉钉corpId
        "agentId": "", // 钉钉agentId
        "messageType": "card", // 钉钉消息类型，markdown或card
        "cardTemplateId": "", // 钉钉卡片模板ID
        "showThinking": true, // 是否显示思考过程
        "debug": false, // 是否开启调试
        "execApprovals": {
            "enabled": false, // 是否允许执行命令行审批
            "mode": "button", // 审批模式，text或button
            "templateId": "", // 审批卡片模板ID
            "timeoutMs": 300000 // 审批超时时间
        }
    }
}
```

命令白名单在 `exec-commands.json` 中维护，该配置也建议外挂并持久化：

```json
{
  "allowedCommands": ["ls", "ps", "kubectl", "docker"],
  "deniedCommands": ["rm", "sudo"]
}
```

或使用环境变量（覆盖 `openai` 配置）：

```bash
export OPENAI_API_KEY="your-api-key"
export OPENAI_MODEL="gpt-4o"
export OPENAI_BASE_URL="https://api.openai.com/v1"
```

### 3. 运行

```bash
# 命令行模式
pnpm dev
# 钉钉机器人模式（服务端模式）
pnpm dingtalk
```

## 项目结构

```
deepagents_srebot/
├── src/
│   ├── index.ts                 # CLI 入口
│   ├── dingtalk.ts              # DingTalk 入口
│   ├── agent.ts                 # 主代理创建
│   ├── config.ts                # 配置加载
│   ├── commands/                # 斜杠命令 /new /compact /status
│   ├── compaction/              # 压缩与摘要
│   ├── middleware/              # 记忆加载/flush
│   ├── subagents/               # 子代理（skill-writer-agent）
│   ├── tools/                   # exec 工具与策略
│   └── channels/
│       └── dingtalk/            # 钉钉消息处理与审批
├── workspace/
│   ├── MEMORY.md                # 长期记忆
│   ├── memory/                  # 每日记忆
│   └── skills/                  # 技能目录（SKILL.md）
├── config.json                  # 主配置
├── exec-commands.json           # 命令白名单/黑名单
└── package.json
```

## 使用示例

### 记忆 + 压缩

```
你: 请记住我叫小S，是一名 SRE 工程师
助手: 已保存到长期记忆

你: /status
助手: 会话状态 ... Token 使用 ... 自动压缩阈值 ...

你: /compact 只保留关键决策
助手: 上下文压缩完成 ...
```

### 技能编写子代理

```
你: 帮我创建一个天气查询的技能
助手: 已调用 skill-writer-agent 创建 workspace/skills/weather-query/SKILL.md
```

### 命令执行（白名单 + 审批）

```
你: 执行 kubectl get events -A
助手: 触发审批 ... 执行完成并返回结果
```

### DingTalk 机器人

```
pnpm dingtalk
```

- 需要在[钉钉开发者后台](https://open-dev.dingtalk.com/fe/card) 开启消息卡片功能。在本项目template中提供了两个卡片模板，可以导入使用。
- 在应用的权限管理页面，需要开启以下权限：
  - ✅ Card.Instance.Write — 创建和投放卡片实例
  - ✅ Card.Streaming.Write — 对卡片进行流式更新
- **注意钉钉应用机器人需要配置可见人员并发布**

## 关于容器部署
```bash
#  构建并推送镜像（注意：Mac 用户需要指定 --platform linux/amd64）
docker build --platform linux/amd64 -f deploy/Dockerfile -t your-registry/deepagents-srebot:latest .
docker push your-registry/deepagents-srebot:latest
#  K8S部署：创建 Secret（也可以手动base64）
kubectl create secret generic deepagents-srebot-config \
  --from-file=config.json=./config.json

#  部署，需要持久化workspace目录（主要是记忆，SKILLS关键目录）。见PVC相关配置
kubectl apply -f deploy/deploy-all.yaml
```

## 后续尽快支持功能。。。

> 以下为优先级较高的功能，其余功能会随着OpenClaw官方库的迭代逐步更新。

- [ ] Memory机制支持混合检索架构，采用SQLite或Milvus+Mysql(还没想好，可能都支持)。实现语义搜索和关键词检索。
- [ ] 支持独立记忆模式，支持主会话/群聊的记忆隔离。
- [ ] 支持sandbox机制，支持沙盒环境下的命令执行(这里可能先由K8S实现)。

## 许可证

MIT