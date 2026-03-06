---
name: hologres-cost-analysis
description: 分析阿里云 Hologres 成本优化机会。适用于“基于 Prometheus 指标判断哪些 Hologres 实例和 Worker 节点可降配/缩容”的请求，包括拉取实例与 Worker 的 CPU/内存时序指标，结合 Query 延迟/失败率/连接使用率等安全指标，输出降配候选、阻断项和风险提示。
---

# Hologres Cost Analysis

## Overview

基于 Prometheus `query_range` 拉取 Hologres 实例与 Worker 节点负载指标，生成成本优化报告。  
报告重点输出实例降配候选、节点缩容候选、负载不均风险，帮助先做低风险成本优化。

## Inputs

必需输入：

- Prometheus `query_range` URL（形如 `.../api/v1/query_range`）
- 分析时间窗口（默认最近 1 小时，可改 24 小时/7 天）
- 采样步长（默认 `60s`）

默认采集以下指标（分三类）：

- 容量主判定（CPU/内存）：
  - `AliyunHologres_standard_standard_cpu_usage`
  - `AliyunHologres_standard_standard_cpu_usage_by_worker`
  - `AliyunHologres_standard_standard_memory_usage`
  - `AliyunHologres_standard_standard_memory_usage_by_worker`
  - `AliyunHologres_follower_follower_cpu_usage`
  - `AliyunHologres_follower_follower_cpu_usage_by_worker`
  - `AliyunHologres_follower_follower_memory_usage`
  - `AliyunHologres_follower_follower_memory_usage_by_worker`
- 安全阻断（达到阈值则暂缓降配）：
  - `AliyunHologres_standard_standard_query_latency_p99`
  - `AliyunHologres_follower_follower_query_latency_p99`
  - `AliyunHologres_standard_standard_failed_query_qps`
  - `AliyunHologres_follower_follower_failed_query_qps`
  - `AliyunHologres_standard_standard_max_connection_usage`
  - `AliyunHologres_follower_follower_max_connection_usage`
- 风险注释（辅助判断）：
  - `AliyunHologres_standard_standard_query_qps`
  - `AliyunHologres_follower_follower_query_qps`
  - `AliyunHologres_standard_standard_dml_rps`
  - `AliyunHologres_standard_standard_replica_sync_lag`
  - `AliyunHologres_follower_follower_replica_sync_lag`
  - `AliyunHologres_standard_standard_file_sync_lag`
  - `AliyunHologres_standard_standard_hot_storage_used_percentage`
  - `AliyunHologres_follower_follower_hot_storage_used_percentage`
  - `AliyunHologres_standard_standard_cold_storage_used_percentage`
  - `AliyunHologres_follower_follower_cold_storage_used_percentage`

## Workflow

1. 运行分析脚本拉取指标并生成报告：

```bash
python3 workspace/skills/hologres-cost-analysis/scripts/analyze_hologres_cost.py \
  --prom-url "https://workspace-default-cms-1336501338520301-cn-shanghai.cn-shanghai.log.aliyuncs.com/prometheus/workspace-default-cms-1336501338520301-cn-shanghai/aliyun-prom-cms-2e5dfa3fe9a22cb1590cc/api/v1/query_range" \
  --hours 1 \
  --step 60s \
  --latency-p99-threshold-ms 3000 \
  --failed-query-qps-threshold 1 \
  --connection-usage-threshold 80 \
  --output-json workspace/tmp/hologres-cost-analysis.json \
  --output-md workspace/tmp/hologres-cost-analysis.md
```

2. 先看 Markdown 报告里的 `Top Downsize Candidates` 和 `Safety Blockers`。
3. 对每个候选实例做二次确认：
   - 是否存在业务峰值窗口未覆盖（建议再跑 24h + 7d）
   - 是否有容量增长计划、临时大促、批任务高峰
   - 是否存在负载倾斜（先调优再降配）

## Output

脚本输出两份文件：

- JSON：结构化明细，便于后续自动化处理。
- Markdown：完整分析报告，包含：
  - **概览**：分析窗口、阈值参数、最低规格约束
  - **汇总表**：各判定类别实例数量
  - **降配候选一览**：快速筛选表（当前配置/CPU/Mem/延迟/判定/建议目标规格）
  - **安全阻断项**：阻断实例及原因
  - **逐实例详细分析**：
    - 资源利用率表（CPU/Memory 的 avg/p50/p95/max）
    - 服务质量指标表（P99延迟、FailQPS、连接率与阈值对比）
    - Worker 节点明细（每个 Worker 的 CPU/内存、负载倾斜检测）
    - 复制与存储指标
    - 判定结果与依据（每条 recommendation 的 level + action + reason）
    - 当前配置（根据 Worker 数推断的 CU/内存/节点数）
    - 建议目标规格（基于 p95 用量 + 余量计算，含预计可释放 CU 和降幅百分比）
  - **判定规则说明**：各 level 的阈值条件对照表
  - **注意事项**：使用限制与二次确认清单

关键字段（JSON）：

- `instance_cpu` / `instance_memory`: `avg/p50/p95/max`
- `workers[]`: 每个 Worker 的 CPU/内存统计
- `extra_metrics_summary`: Query QPS、P99 延迟、失败 Query QPS、连接使用率、复制延迟、存储使用率
- `recommendations[]`: 动作建议与依据（高置信降配/中置信降配/安全阻断/保持配置/最低规格/数据不足）

## Hologres 最低规格约束

阿里云 Hologres 实例最低规格为 **32CU / 128GB / 2节点**，降配不可低于此规格。

脚本根据 Prometheus `by_worker` 指标自动推断当前配置（Worker 数 × 16CU/64GB = 实例规格），并在报告中同时展示"当前配置"和"建议目标规格"。

当实例 Worker 数量 <= 2 且被判定为降配候选时，会追加 `at-minimum-spec` 标记，提醒该实例已处于最低规格。

建议目标规格从标准梯度中选择比当前规格更低且满足余量要求的最小规格，不会推荐低于 32CU/128GB 的配置。

已知规格梯度（阿里云控制台实际可选，每节点 16CU / 64GB）：

| CU | 内存 | 计算节点数 |
|---:|---:|---:|
| 32 | 128GB | 2 |
| 64 | 256GB | 4 |
| 96 | 384GB | 6 |
| 128 | 512GB | 8 |
| 160 | 640GB | 10 |
| 192 | 768GB | 12 |
| 256 | 1024GB | 16 |
| 384 | 1536GB | 24 |

## Decision Rules (Default)

- 高置信降配（`high-confidence-downsize`）：
  - 实例 `CPU avg < 20%` 且 `CPU p95 < 40%`
  - 实例 `Memory avg < 35%` 且 `Memory p95 < 55%`
- 中置信降配（`medium-confidence-downsize`）：
  - 实例 `CPU avg < 35%` 且 `CPU p95 < 60%`
  - 实例 `Memory avg < 50%` 且 `Memory p95 < 70%`
- 保持配置（`hold-capacity`）：
  - `CPU p95 >= 85%` 或 `Memory p95 >= 85%`
- 安全阻断（`safety-blocker`）：
  - `query_latency_p99 p95 >= 3000ms`（可调）
  - `failed_query_qps p95 >= 1`（可调）
  - `max_connection_usage p95 >= 80%`（可调）
- 最低规格标记（`at-minimum-spec`）：
  - Worker 数量 <= 2 且被判为降配候选时追加

节点优化规则：

- 节点缩容候选（`node-reduction-candidate`）：
  - 低负载 Worker 占比 >= 50%，且实例整体无高峰风险
- 负载不均（`rebalance-before-downsize`）：
  - Worker `CPU p95` 最大最小差 >= 35 个百分点
- 复制/存储提示：
  - `replication-note`: 报告 `replica_sync_lag`/`file_sync_lag`
  - `storage-note`: 报告冷热存储使用率，辅助账单优化策略

## Required Follow-up

给出降配建议时，必须同时说明：

1. 分析时间窗口（例如最近 1 小时）
2. 使用的阈值
3. 缺失数据或风险点（指标缺失、峰值窗口未覆盖、明显倾斜）

## Resources

- Script: `scripts/analyze_hologres_cost.py`
- Reference: `references/metric_catalog.md`
