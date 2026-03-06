# Hologres Cost Metric Catalog

## Priority A: 直接用于降配判定（已接入脚本）

### 容量主判定

- `AliyunHologres_standard_standard_cpu_usage`
- `AliyunHologres_standard_standard_cpu_usage_by_worker`
- `AliyunHologres_standard_standard_memory_usage`
- `AliyunHologres_standard_standard_memory_usage_by_worker`
- `AliyunHologres_follower_follower_cpu_usage`
- `AliyunHologres_follower_follower_cpu_usage_by_worker`
- `AliyunHologres_follower_follower_memory_usage`
- `AliyunHologres_follower_follower_memory_usage_by_worker`

### 安全阻断（达到阈值则暂缓降配）

- `AliyunHologres_standard_standard_query_latency_p99`
- `AliyunHologres_follower_follower_query_latency_p99`
- `AliyunHologres_standard_standard_failed_query_qps`
- `AliyunHologres_follower_follower_failed_query_qps`
- `AliyunHologres_standard_standard_max_connection_usage`
- `AliyunHologres_follower_follower_max_connection_usage`

默认阻断阈值（脚本参数可调）：

- `query_latency_p99 p95 >= 3000ms`
- `failed_query_qps p95 >= 1`
- `max_connection_usage p95 >= 80%`

## Priority B: 风险与上下文（已接入脚本，默认作注释）

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

## Priority C: 当前不直接参与判定（可按场景扩展）

这些指标有用，但更适合专项分析，不建议直接作为降配阈值：

- `AliyunHologres_*_query_latency`（非 p99 版本）
- `AliyunHologres_*_longest_active_query_time`
- `AliyunHologres_*_connections` / `*_connections_by_db` / `*_connections_by_fe`
- `AliyunHologres_*_hot_io_read_throughput` / `*_hot_io_write_throughput`
- `AliyunHologres_*_cold_io_read_throughput` / `*_cold_io_write_throughput`
- `AliyunHologres_*_hot_storage_used` / `*_cold_storage_used`
- `AliyunHologres_*_memory_usage_detail`
- `cloud_monitor_instance_info`

理由：

- 维度过细（DB/FE）或缺少统一容量阈值，容易误伤。
- 部分是诊断指标（排障价值高），但不适合作为降配硬门槛。

补充：

- `AliyunHologres_connection_usage` 在部分大盘中可用，但常见只带 `instanceId` 不带 `instanceName`，默认不作为主判定指标；如需启用，建议先加实例 ID 到名称映射表。

## Prometheus Query Example

```bash
END=$(date +%s)
START=$(($END - 3600))
STEP="60s"

curl -G -s \
  --data-urlencode "query=AliyunHologres_standard_standard_cpu_usage{}" \
  --data-urlencode "start=$START" \
  --data-urlencode "end=$END" \
  --data-urlencode "step=$STEP" \
  "https://<your-prometheus>/api/v1/query_range"
```
