---
name: alert-rca
description: 告警事故根因定位 - 系统化分析告警事件，通过多源数据关联分析快速定位根因，重建事故时间线，提供可操作的修复建议
---

# 告警事故根因定位 (Alert Root Cause Analysis)

## Overview

本技能提供系统化的告警事故根因定位方法论，帮助SRE团队快速分析告警事件，识别根本原因，并提供可操作的修复建议。支持多源数据（日志、指标、链路追踪、事件）的关联分析，重建完整的事故时间线。

### 适用场景

- **突发告警响应**：收到P0/P1级别告警，需要快速定位根因
- **故障复盘分析**：事后复盘，重建事故时间线，识别改进点
- **关联告警分析**：多个服务同时告警，需要识别根因告警和衍生告警
- **慢性问题诊断**：持续性性能下降或间歇性故障的根因分析
- **容量问题定位**：资源瓶颈导致的性能问题分析

### 核心能力

- 🔍 **多源数据关联**：整合日志、指标、链路、事件等多维度数据
- ⏱️ **时间线重建**：按时间顺序重建事故发展过程
- 🔗 **相关性分析**：识别告警之间的因果关系
- 🎯 **根因定位**：采用系统化方法定位根本原因
- 💡 **修复建议**：提供具体可执行的修复和预防措施

---

## Input Format

### 告警数据输入结构

```json
{
  "alert": {
    "id": "alert-unique-id",
    "title": "告警标题",
    "severity": "P0|P1|P2|P3",
    "status": "firing|resolved",
    "source": "prometheus|grafana|datadog|custom",
    "triggered_at": "2024-01-15T08:30:00Z",
    "resolved_at": "2024-01-15T09:15:00Z",
    "description": "告警描述信息",
    "labels": {
      "service": "service-name",
      "environment": "production",
      "cluster": "cluster-01",
      "instance": "ip:port"
    },
    "annotations": {
      "summary": "简要说明",
      "runbook_url": "https://wiki/runbook"
    }
  },
  "metrics": {
    "query_range": {
      "start": "2024-01-15T08:00:00Z",
      "end": "2024-01-15T09:30:00Z",
      "step": "1m"
    },
    "data": [
      {
        "metric": "cpu_usage_percent",
        "labels": {"instance": "10.0.1.100:9100"},
        "values": [[timestamp, value], ...]
      }
    ]
  },
  "logs": {
    "query": "error OR exception OR fatal",
    "time_range": {
      "start": "2024-01-15T08:00:00Z",
      "end": "2024-01-15T09:30:00Z"
    },
    "entries": [
      {
        "timestamp": "2024-01-15T08:30:15Z",
        "level": "ERROR",
        "service": "api-gateway",
        "message": "Connection timeout to upstream",
        "context": {"trace_id": "abc123", "span_id": "def456"}
      }
    ]
  },
  "traces": {
    "trace_ids": ["abc123", "xyz789"],
    "spans": [
      {
        "trace_id": "abc123",
        "span_id": "span-001",
        "parent_span_id": null,
        "service": "api-gateway",
        "operation": "GET /api/users",
        "start_time": "2024-01-15T08:30:10Z",
        "duration_ms": 5000,
        "status": "error",
        "tags": {"error": true, "http.status_code": 503}
      }
    ]
  },
  "events": {
    "deployments": [
      {
        "timestamp": "2024-01-15T08:25:00Z",
        "service": "user-service",
        "version": "v2.3.1",
        "deployer": "ci-cd-pipeline"
      }
    ],
    "infrastructure_changes": [
      {
        "timestamp": "2024-01-15T08:20:00Z",
        "type": "scaling",
        "resource": "eks-cluster",
        "details": "Scaled nodes from 10 to 15"
      }
    ],
    "manual_operations": [
      {
        "timestamp": "2024-01-15T08:15:00Z",
        "operator": "sre-oncall",
        "action": "database_config_update"
      }
    ]
  },
  "related_alerts": [
    {
      "id": "related-alert-1",
      "title": "下游服务延迟高",
      "triggered_at": "2024-01-15T08:32:00Z",
      "correlation_score": 0.95
    }
  ],
  "context": {
    "affected_services": ["api-gateway", "user-service", "payment-service"],
    "affected_users": "约5000用户",
    "business_impact": "支付功能不可用",
    "previous_incidents": ["INC-2024-001"]
  }
}
```

### 数据获取建议

| 数据类型 | 推荐工具 | 关键查询示例 |
|---------|---------|-------------|
| 指标 | Prometheus/Grafana | `rate(http_requests_total[5m])`, `container_cpu_usage_seconds_total` |
| 日志 | ELK/Loki/Splunk | `service="api-gateway" AND (level="ERROR" OR level="FATAL")` |
| 链路 | Jaeger/Zipkin/SkyWalking | `serviceName="api-gateway" AND duration>5s` |
| 事件 | PagerDuty/OpsGenie/内部系统 | 部署记录、配置变更、扩容事件 |

---

## Analysis Workflow

### Phase 1: 信息收集与预处理 (5-10分钟)

#### 1.1 告警基本信息确认

```markdown
□ 告警ID和标题
□ 触发时间和持续时间
□ 严重级别和影响范围
□ 当前状态（进行中/已恢复）
□ 告警来源和监控规则
```

#### 1.2 数据收集清单

**必须收集的数据：**
- [ ] 告警触发前后30分钟的指标数据
- [ ] 相关服务的ERROR/FATAL级别日志
- [ ] 涉及服务的链路追踪数据
- [ ] 告警时间窗口内的事件（部署、变更、扩容等）

**建议收集的数据：**
- [ ] 上下游服务的健康状态
- [ ] 基础设施层指标（CPU、内存、网络、磁盘）
- [ ] 数据库性能指标（连接数、慢查询、锁等待）
- [ ] 缓存命中率和服务状态

#### 1.3 数据质量检查

```markdown
□ 时间范围是否覆盖完整的事故过程
□ 各数据源的时间戳是否对齐（注意时区）
□ 关键指标数据是否完整，有无缺失
□ 日志采样率是否足够（高流量场景）
```

### Phase 2: 时间线重建 (10-15分钟)

#### 2.1 构建统一时间线

将所有事件按时间顺序排列，标注关键节点：

```
时间线模板：

[时间] [类型] [服务/组件] [事件描述] [影响评估]

示例：
08:15:00 [变更] [database] 配置更新 - max_connections从100改为200
08:20:00 [运维] [eks-cluster] 节点扩容 10→15
08:25:00 [部署] [user-service] v2.3.1 发布
08:30:00 [告警] [api-gateway] P0: 错误率超过阈值 (5%→25%)
08:30:10 [链路] [api-gateway] 延迟突增 p99: 200ms→5000ms
08:30:15 [日志] [api-gateway] 首次出现 "Connection timeout to upstream"
08:32:00 [告警] [user-service] P1: 下游服务延迟高
08:35:00 [告警] [payment-service] P1: 依赖服务不可用
```

#### 2.2 识别关键转折点

标记时间线上的关键事件：
- 🟥 **起点事件**：事故开始的第一个异常信号
- 🟨 **恶化节点**：问题升级的关键时刻
- 🟩 **恢复节点**：服务开始恢复的时间点
- 🟦 **根因候选**：可能的根本原因事件

#### 2.3 相关性标注

在时间线上标注事件之间的关联：

```
08:25:00 [部署] user-service v2.3.1
    ↓ [5分钟后]
08:30:00 [告警] api-gateway 错误率飙升
    ↓ [调用关系]
08:32:00 [告警] user-service 延迟高
```

### Phase 3: 根因分析方法论 (15-30分钟)

#### 3.1 5 Whys 分析法

针对核心症状连续追问"为什么"，直到找到根本原因：

```markdown
问题：api-gateway 错误率飙升到25%

Why 1: 为什么错误率飙升？
→ 因为大量请求超时

Why 2: 为什么请求超时？
→ 因为 user-service 响应时间从200ms增加到5000ms

Why 3: 为什么 user-service 响应变慢？
→ 因为数据库连接池耗尽，请求在等待连接

Why 4: 为什么连接池耗尽？
→ 因为 v2.3.1 版本引入了连接泄漏bug，连接未正确释放

Why 5: 为什么会有连接泄漏？
→ 因为代码重构时遗漏了 finally 块中的 connection.close()

根因：代码缺陷导致数据库连接泄漏
```

#### 3.2 故障树分析 (FTA)

从顶事件（告警）向下分解，识别所有可能的故障路径：

```
                    [api-gateway 错误率高]
                           |
        +------------------+------------------+
        |                                     |
   [上游问题]                            [下游问题]
        |                                     |
   +----+----+                    +-----------+-----------+
   |         |                    |                       |
[流量突增] [配置错误]        [user-service]        [network-issue]
                                  |
                    +-------------+-------------+
                    |                           |
               [cpu-high]                 [db-timeout]
                    |                           |
            [资源不足]               +----------+----------+
                                     |                     |
                               [连接池耗尽]           [慢查询]
                                     |
                           [连接泄漏bug v2.3.1]
```

#### 3.3 变更关联分析

检查时间窗口内的所有变更，评估与告警的相关性：

| 时间 | 变更类型 | 组件 | 变更内容 | 与告警时间差 | 相关性评估 |
|------|---------|------|---------|-------------|-----------|
| 08:15 | 配置变更 | database | max_connections 100→200 | 15分钟 | 低 |
| 08:20 | 扩容 | eks-cluster | 节点 10→15 | 10分钟 | 低 |
| 08:25 | 部署 | user-service | v2.3.1 | 5分钟 | **高** ⭐ |

**评估标准：**
- **高相关**：变更后5分钟内出现异常，且变更组件与告警服务有直接依赖
- **中相关**：变更后5-15分钟出现异常，或变更组件与告警服务有间接依赖
- **低相关**：变更后15分钟以上出现异常，或变更组件与告警服务无直接关联

#### 3.4 依赖拓扑分析

绘制服务依赖关系，识别故障传播路径：

```
流量入口
    ↓
[api-gateway] ←── 告警服务
    ↓
[user-service] ←── 延迟高
    ↓
[database] ←── 连接池耗尽
```

**分析要点：**
1. 从告警服务向上游追溯：是否有流量突增或攻击？
2. 从告警服务向下游追溯：依赖服务是否异常？
3. 检查同级服务：其他调用相同下游的服务是否正常？

### Phase 4: 多源数据关联分析 (15-20分钟)

#### 4.1 指标-日志关联

将指标异常时间点与日志错误关联：

```markdown
指标异常时间：08:30:00 - api-gateway 错误率突增

对应日志模式：
08:30:15 ERROR Connection timeout to upstream (user-service:8080)
08:30:18 ERROR Connection timeout to upstream (user-service:8080)
08:30:22 ERROR Connection timeout to upstream (user-service:8080)
...

结论：错误率上升与连接超时错误强相关
```

#### 4.2 日志-链路关联

通过 trace_id 关联日志和链路：

```markdown
慢请求链路：trace_id=abc123
- api-gateway (5000ms) ← 总耗时
  - user-service (4800ms) ← 主要耗时
    - database query (4500ms) ← 实际耗时

对应日志：
- user-service: "Query execution timeout after 4500ms"
- database: "Connection pool exhausted, waiting for connection"

结论：数据库连接池耗尽导致查询超时
```

#### 4.3 事件-指标关联

将变更事件与指标变化关联：

```markdown
部署事件：08:25:00 user-service v2.3.1

指标变化：
- 08:25:00 部署开始
- 08:26:00 服务重启，错误率短暂上升（正常）
- 08:27:00 错误率恢复正常
- 08:28:00 数据库连接数开始缓慢上升
- 08:30:00 连接数达到上限，错误率飙升

模式识别：部署后3分钟开始出现资源泄漏特征
```

### Phase 5: 根因确认与验证 (10-15分钟)

#### 5.1 根因假设验证

基于分析提出根因假设，并设计验证方法：

| 假设 | 验证方法 | 预期结果 | 实际结果 | 结论 |
|------|---------|---------|---------|------|
| v2.3.1 导致连接泄漏 | 检查代码变更 | 发现连接未关闭 | 确认finally块缺失 | ✅ 验证通过 |
| 数据库配置不当 | 检查max_connections | 配置合理 | 200连接，正常 | ❌ 排除 |
| 流量突增导致 | 检查QPS趋势 | QPS平稳 | QPS无变化 | ❌ 排除 |

#### 5.2 根因判定标准

满足以下条件可判定为根因：
- [ ] 能够解释所有观察到的症状
- [ ] 有时间上的先后关系（原因在前，结果在后）
- [ ] 有逻辑上的因果关系
- [ ] 有数据支持（日志、指标、代码等）
- [ ] 修复后问题得到解决或缓解

#### 5.3 区分根因与表象

```markdown
表象（Symptoms）：
- api-gateway 错误率高
- user-service 响应慢
- 数据库连接池耗尽

中间原因：
- 数据库连接池耗尽导致查询超时

根本原因（Root Cause）：
- user-service v2.3.1 代码缺陷导致数据库连接泄漏
```

---

## Output Format

### 根因分析报告结构

```markdown
# 告警根因分析报告

## 1. 执行摘要
- **告警ID**: alert-xxx
- **告警标题**: xxx
- **严重级别**: P0/P1/P2/P3
- **影响时间**: 2024-01-15 08:30 - 09:15 (45分钟)
- **影响范围**: 约5000用户，支付功能不可用
- **根因类别**: 代码缺陷/配置错误/资源不足/依赖故障/流量异常
- **根因简述**: user-service v2.3.1 数据库连接泄漏导致级联故障

## 2. 时间线重建

| 时间 | 事件类型 | 服务/组件 | 事件描述 | 影响 |
|------|---------|----------|---------|------|
| 08:15 | 变更 | database | max_connections调整 | 无直接影响 |
| 08:25 | 部署 | user-service | v2.3.1发布 | ⭐ 根因事件 |
| 08:30 | 告警 | api-gateway | 错误率>25% | 直接影响 |
| 08:32 | 告警 | user-service | 延迟高 | 级联影响 |
| 09:15 | 恢复 | all | 服务回滚后恢复 | 问题解决 |

## 3. 根因分析

### 3.1 分析过程
[详细描述分析步骤和推理过程]

### 3.2 根因定位
**根本原因**: user-service v2.3.1 版本引入数据库连接泄漏

**详细说明**:
- 代码重构时遗漏了 finally 块中的 connection.close()
- 每个请求泄漏一个连接，300连接池在5分钟内耗尽
- 连接池耗尽后新请求等待超时，导致级联故障

**证据链**:
1. 部署时间与告警时间强相关（5分钟间隔）
2. 日志显示连接池耗尽错误
3. 代码diff显示连接关闭逻辑缺失
4. 回滚后问题立即恢复

### 3.3 故障传播路径
```
user-service v2.3.1 部署
    ↓
数据库连接泄漏
    ↓
连接池耗尽 (300/300)
    ↓
新请求等待超时 (5s)
    ↓
api-gateway 调用超时
    ↓
错误率飙升 (5%→25%)
    ↓
用户请求失败
```

## 4. 影响评估

### 4.1 业务影响
- **受影响功能**: 支付、订单查询
- **受影响用户**: 约5000用户
- **交易损失**: 预估 $50,000
- **SLA影响**: 可用性从99.9%降至95%

### 4.2 技术影响
- **涉及服务**: api-gateway, user-service, payment-service
- **级联影响**: 3个下游服务受影响
- **数据影响**: 无数据丢失

## 5. 修复措施

### 5.1 已执行措施
- [x] 09:10 回滚 user-service 至 v2.3.0
- [x] 09:15 服务恢复正常
- [x] 09:20 增加连接池监控告警

### 5.2 短期修复建议（24小时内）
- [ ] 修复连接泄漏bug，添加finally块关闭连接
- [ ] 增加连接池使用率监控告警（阈值：80%）
- [ ] 添加连接池耗尽自动扩容机制

### 5.3 长期改进建议（1-2周内）
- [ ] 代码审查流程增加资源泄漏检查清单
- [ ] 集成SonarQube静态分析，检测资源未关闭问题
- [ ] 灰度发布策略优化，增加连接池监控指标观察期
- [ ] 建立故障演练机制，定期模拟连接池耗尽场景

## 6. 预防措施

### 6.1 监控增强
- 添加数据库连接池使用率监控
- 添加连接等待时间监控
- 添加服务间调用超时率监控

### 6.2 流程改进
- 代码审查增加资源管理检查点
- 发布 checklist 增加资源泄漏检查项
- 建立变更与告警关联分析机制

### 6.3 架构优化
- 实现数据库连接池自动扩容
- 增加熔断降级机制
- 优化连接池配置（大小、超时、重试）

## 7. 相关资源

- [告警详情](link-to-alert)
- [Grafana Dashboard](link-to-dashboard)
- [错误日志](link-to-logs)
- [代码变更diff](link-to-commit)
- [事后复盘文档](link-to-postmortem)

## 8. 附录

### 8.1 关键指标截图
[指标图表]

### 8.2 关键日志片段
```
[ERROR] 2024-01-15 08:30:15 - Connection pool exhausted
java.sql.SQLException: Connection pool is full
```

### 8.3 代码片段
```java
// 问题代码
Connection conn = dataSource.getConnection();
// 缺少 finally { conn.close(); }
```
```

---

## Examples

### 示例1: 代码缺陷导致的级联故障

**场景**: 微服务架构，user-service 部署后出现大量超时

**输入数据**:
- 告警：api-gateway P0 错误率>20%
- 指标：user-service 延迟 p99 从200ms增至5000ms
- 日志：大量 "Connection timeout" 错误
- 事件：user-service v2.3.1 部署于5分钟前

**分析过程**:
1. 时间线显示部署后5分钟出现异常
2. 故障树分析指向数据库连接问题
3. 日志显示连接池耗尽
4. 代码diff发现连接泄漏

**输出结果**:
- 根因：v2.3.1 连接泄漏bug
- 修复：回滚 + 修复代码
- 预防：代码审查 + 静态分析

### 示例2: 配置变更导致的性能下降

**场景**: 数据库配置变更后查询变慢

**输入数据**:
- 告警：order-service P1 响应时间>2s
- 指标：数据库查询平均耗时从50ms增至2000ms
- 事件：database 配置变更（query_cache_size调整）
- 日志：大量慢查询日志

**分析过程**:
1. 时间线显示配置变更后立即出现异常
2. 指标显示查询耗时突增
3. 慢查询日志显示相同SQL执行变慢
4. 配置对比发现query_cache_size设置为0

**输出结果**:
- 根因：query_cache_size误设置为0，导致缓存失效
- 修复：恢复配置
- 预防：配置变更review + 性能基线对比

### 示例3: 资源不足导致的雪崩效应

**场景**: 促销活动时服务大面积不可用

**输入数据**:
- 告警：多个服务P0错误率高
- 指标：CPU使用率100%，内存使用率95%
- 事件：促销活动开始
- 日志：大量 "OutOfMemoryError"

**分析过程**:
1. 时间线与促销活动开始时间一致
2. 资源指标显示CPU/内存打满
3. 多个服务同时OOM
4. 容量规划显示资源预留不足

**输出结果**:
- 根因：容量规划不足，未考虑促销流量
- 修复：紧急扩容 + 限流
- 预防：容量规划 + 自动扩缩容 + 限流降级

---

## Best Practices

### 数据收集最佳实践

1. **时间范围**: 告警前30分钟到告警后15分钟，确保覆盖完整上下文
2. **数据采样**: 高流量场景注意日志采样率，必要时临时提高采样率
3. **时间对齐**: 统一使用UTC时间，避免时区混乱
4. **数据保留**: 关键数据截图保存，防止过期丢失

### 分析过程最佳实践

1. **避免先入为主**: 不要过早下结论，让数据说话
2. **相关性≠因果性**: 时间相关不代表因果关系，需要逻辑验证
3. **考虑多个假设**: 同时验证多个根因假设，避免遗漏
4. **记录推理过程**: 详细记录分析步骤，便于复盘和知识传承

### 报告撰写最佳实践

1. **执行摘要前置**: 忙碌的读者可以快速了解核心结论
2. **证据链完整**: 每个结论都需要数据支撑
3. **可操作建议**: 避免空洞的建议，提供具体的执行步骤
4. **知识沉淀**: 将分析过程转化为可复用的知识

---

## Tools & Resources

### 推荐工具

| 用途 | 工具推荐 |
|------|---------|
| 指标分析 | Grafana, Prometheus, Datadog |
| 日志分析 | ELK Stack, Loki, Splunk |
| 链路追踪 | Jaeger, Zipkin, SkyWalking |
| 事件管理 | PagerDuty, OpsGenie, Incident.io |
| 可视化 | Mermaid, Draw.io, Excalidraw |

### 参考资源

- [Google SRE Book - Incident Management](https://sre.google/sre-book/managing-incidents/)
- [AWS Well-Architected - Reliability Pillar](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/welcome.html)
- [Microsoft Azure - Incident Response](https://docs.microsoft.com/en-us/azure/security/fundamentals/incident-response)

---

## Checklist Summary

### 分析前检查
- [ ] 告警基本信息完整
- [ ] 数据收集范围足够
- [ ] 时间戳已对齐

### 分析中检查
- [ ] 时间线已重建
- [ ] 根因假设已验证
- [ ] 证据链完整

### 分析后检查
- [ ] 报告结构完整
- [ ] 修复建议可操作
- [ ] 预防措施已规划
- [ ] 相关资源已归档
