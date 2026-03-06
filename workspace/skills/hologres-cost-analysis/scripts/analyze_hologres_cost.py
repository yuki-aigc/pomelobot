#!/usr/bin/env python3
"""
Analyze Hologres cost optimization opportunities from Prometheus query_range metrics.

Decision style:
- CPU/memory usage decides "downsize potential"
- latency/error/connection usage works as safety blockers
- replication/storage metrics are risk notes
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import re
import statistics
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional

METRIC_SPECS: Dict[str, Dict[str, str]] = {
    # Core capacity metrics
    "AliyunHologres_standard_standard_cpu_usage": {
        "scope": "instance",
        "kind": "cpu",
        "instance_type": "standard",
    },
    "AliyunHologres_standard_standard_cpu_usage_by_worker": {
        "scope": "worker",
        "kind": "cpu",
        "instance_type": "standard",
    },
    "AliyunHologres_standard_standard_memory_usage": {
        "scope": "instance",
        "kind": "memory",
        "instance_type": "standard",
    },
    "AliyunHologres_standard_standard_memory_usage_by_worker": {
        "scope": "worker",
        "kind": "memory",
        "instance_type": "standard",
    },
    "AliyunHologres_follower_follower_cpu_usage": {
        "scope": "instance",
        "kind": "cpu",
        "instance_type": "follower",
    },
    "AliyunHologres_follower_follower_cpu_usage_by_worker": {
        "scope": "worker",
        "kind": "cpu",
        "instance_type": "follower",
    },
    "AliyunHologres_follower_follower_memory_usage": {
        "scope": "instance",
        "kind": "memory",
        "instance_type": "follower",
    },
    "AliyunHologres_follower_follower_memory_usage_by_worker": {
        "scope": "worker",
        "kind": "memory",
        "instance_type": "follower",
    },
    # Workload and service quality guardrails
    "AliyunHologres_standard_standard_query_qps": {
        "scope": "instance",
        "kind": "query_qps",
        "instance_type": "standard",
    },
    "AliyunHologres_follower_follower_query_qps": {
        "scope": "instance",
        "kind": "query_qps",
        "instance_type": "follower",
    },
    "AliyunHologres_standard_standard_dml_rps": {
        "scope": "instance",
        "kind": "dml_rps",
        "instance_type": "standard",
    },
    "AliyunHologres_standard_standard_failed_query_qps": {
        "scope": "instance",
        "kind": "failed_query_qps",
        "instance_type": "standard",
    },
    "AliyunHologres_follower_follower_failed_query_qps": {
        "scope": "instance",
        "kind": "failed_query_qps",
        "instance_type": "follower",
    },
    "AliyunHologres_standard_standard_query_latency_p99": {
        "scope": "instance",
        "kind": "query_latency_p99",
        "instance_type": "standard",
    },
    "AliyunHologres_follower_follower_query_latency_p99": {
        "scope": "instance",
        "kind": "query_latency_p99",
        "instance_type": "follower",
    },
    "AliyunHologres_standard_standard_max_connection_usage": {
        "scope": "instance",
        "kind": "max_connection_usage",
        "instance_type": "standard",
    },
    "AliyunHologres_follower_follower_max_connection_usage": {
        "scope": "instance",
        "kind": "max_connection_usage",
        "instance_type": "follower",
    },
    "AliyunHologres_standard_standard_longest_active_query_time": {
        "scope": "instance",
        "kind": "longest_active_query_time",
        "instance_type": "standard",
    },
    "AliyunHologres_follower_follower_longest_active_query_time": {
        "scope": "instance",
        "kind": "longest_active_query_time",
        "instance_type": "follower",
    },
    # Replication and storage risk notes
    "AliyunHologres_standard_standard_replica_sync_lag": {
        "scope": "instance",
        "kind": "replica_sync_lag",
        "instance_type": "standard",
    },
    "AliyunHologres_follower_follower_replica_sync_lag": {
        "scope": "instance",
        "kind": "replica_sync_lag",
        "instance_type": "follower",
    },
    "AliyunHologres_standard_standard_file_sync_lag": {
        "scope": "instance",
        "kind": "file_sync_lag",
        "instance_type": "standard",
    },
    "AliyunHologres_standard_standard_hot_storage_used_percentage": {
        "scope": "instance",
        "kind": "hot_storage_used_percentage",
        "instance_type": "standard",
    },
    "AliyunHologres_follower_follower_hot_storage_used_percentage": {
        "scope": "instance",
        "kind": "hot_storage_used_percentage",
        "instance_type": "follower",
    },
    "AliyunHologres_standard_standard_cold_storage_used_percentage": {
        "scope": "instance",
        "kind": "cold_storage_used_percentage",
        "instance_type": "standard",
    },
    "AliyunHologres_follower_follower_cold_storage_used_percentage": {
        "scope": "instance",
        "kind": "cold_storage_used_percentage",
        "instance_type": "follower",
    },
}

DEFAULT_METRICS = sorted(METRIC_SPECS.keys())


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Query Hologres metrics from Prometheus and generate downsizing suggestions."
    )
    parser.add_argument("--prom-url", required=True, help="Prometheus query_range API URL")
    parser.add_argument(
        "--hours",
        type=float,
        default=1.0,
        help="Lookback hours when --start-ts is not provided (default: 1)",
    )
    parser.add_argument("--start-ts", type=int, help="Unix timestamp (seconds)")
    parser.add_argument("--end-ts", type=int, help="Unix timestamp (seconds), default: now")
    parser.add_argument("--step", default="60s", help="query_range step (default: 60s)")
    parser.add_argument("--timeout", type=int, default=30, help="HTTP timeout seconds")
    parser.add_argument(
        "--instance-regex",
        help="Filter instance name with regex (optional)",
    )
    parser.add_argument(
        "--latency-p99-threshold-ms",
        type=float,
        default=3000.0,
        help="Block downsizing if query_latency_p99 p95 exceeds this threshold (default: 3000)",
    )
    parser.add_argument(
        "--failed-query-qps-threshold",
        type=float,
        default=1.0,
        help="Block downsizing if failed_query_qps p95 exceeds this threshold (default: 1.0)",
    )
    parser.add_argument(
        "--connection-usage-threshold",
        type=float,
        default=80.0,
        help="Block downsizing if max_connection_usage p95 exceeds this percent (default: 80)",
    )
    parser.add_argument(
        "--output-json",
        default="workspace/tmp/hologres-cost-analysis.json",
        help="Output JSON path",
    )
    parser.add_argument(
        "--output-md",
        default="workspace/tmp/hologres-cost-analysis.md",
        help="Output Markdown report path",
    )
    return parser.parse_args()


def query_range(
    prom_url: str,
    query: str,
    start_ts: int,
    end_ts: int,
    step: str,
    timeout: int,
) -> List[Dict[str, Any]]:
    params = urllib.parse.urlencode(
        {"query": query, "start": str(start_ts), "end": str(end_ts), "step": step}
    )
    req = urllib.request.Request(f"{prom_url}?{params}", method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8")
    payload = json.loads(raw)
    status = payload.get("status")
    if status != "success":
        err = payload.get("error", "unknown error")
        raise RuntimeError(f"prometheus status={status} error={err}")
    return payload.get("data", {}).get("result", [])


def percentile(values: List[float], p: float) -> float:
    if not values:
        raise ValueError("empty values")
    if len(values) == 1:
        return values[0]
    sorted_vals = sorted(values)
    rank = (len(sorted_vals) - 1) * (p / 100.0)
    low = math.floor(rank)
    high = math.ceil(rank)
    if low == high:
        return sorted_vals[int(rank)]
    low_v = sorted_vals[low]
    high_v = sorted_vals[high]
    return low_v + (high_v - low_v) * (rank - low)


def build_stats(raw_values: List[List[Any]]) -> Optional[Dict[str, float]]:
    nums: List[float] = []
    for item in raw_values:
        if len(item) < 2:
            continue
        try:
            value = float(item[1])
        except (TypeError, ValueError):
            continue
        if math.isnan(value) or math.isinf(value):
            continue
        nums.append(value)
    if not nums:
        return None
    return {
        "count": len(nums),
        "min": min(nums),
        "avg": statistics.fmean(nums),
        "p50": percentile(nums, 50),
        "p95": percentile(nums, 95),
        "max": max(nums),
    }


def combine_stats(stats_list: List[Dict[str, float]]) -> Optional[Dict[str, float]]:
    if not stats_list:
        return None
    total = sum(max(int(item.get("count", 0)), 0) for item in stats_list)
    if total <= 0:
        return None
    weighted_avg = sum(item["avg"] * item["count"] for item in stats_list) / total
    return {
        "count": total,
        "min": min(item["min"] for item in stats_list),
        "avg": weighted_avg,
        "p50": statistics.fmean(item["p50"] for item in stats_list),
        "p95": max(item["p95"] for item in stats_list),
        "max": max(item["max"] for item in stats_list),
        "series_count": len(stats_list),
    }


def pick_first(labels: Dict[str, str], keys: List[str]) -> Optional[str]:
    for key in keys:
        value = labels.get(key)
        if value:
            return str(value)
    return None


def infer_instance_name(labels: Dict[str, str]) -> str:
    keys = [
        "instanceName",
        "instance_name",
        "hologresInstanceName",
        "hologres_instance_name",
        "resourceName",
        "resource_name",
        "instance",
        "name",
    ]
    value = pick_first(labels, keys)
    if value:
        return value
    return "unknown-instance"


def infer_instance_id(labels: Dict[str, str]) -> Optional[str]:
    return pick_first(labels, ["id", "instanceId", "instance_id"])


def infer_worker_name(labels: Dict[str, str]) -> str:
    keys = [
        "workerName",
        "worker_name",
        "worker",
        "workerId",
        "worker_id",
        "node",
        "pod",
        "host",
        "fe",
        "db",
    ]
    value = pick_first(labels, keys)
    if value:
        return value
    return "unknown-worker"


def create_instance_record() -> Dict[str, Any]:
    return {
        "instance_ids": set(),
        "types": set(),
        "instance_metrics": {"cpu": [], "memory": []},
        "worker_metrics": {},
        "extra_metrics": {},
    }


def append_metric(
    instances: Dict[str, Dict[str, Any]],
    metric_name: str,
    labels: Dict[str, str],
    stats: Dict[str, float],
) -> None:
    spec = METRIC_SPECS.get(metric_name)
    if spec is None:
        return

    instance_name = infer_instance_name(labels)
    if instance_name == "unknown-instance":
        # Skip anonymous series to avoid creating non-actionable pseudo instances.
        return
    item = instances.setdefault(instance_name, create_instance_record())
    instance_id = infer_instance_id(labels)
    if instance_id:
        item["instance_ids"].add(instance_id)
    item["types"].add(spec["instance_type"])

    if spec["scope"] == "worker":
        worker_name = infer_worker_name(labels)
        worker_item = item["worker_metrics"].setdefault(worker_name, {"cpu": [], "memory": []})
        worker_item[spec["kind"]].append(stats)
        return

    if spec["kind"] in ("cpu", "memory"):
        item["instance_metrics"][spec["kind"]].append(stats)
        return

    extra_series = item["extra_metrics"].setdefault(spec["kind"], [])
    extra_series.append(stats)


def get_extra(
    extra_metrics: Dict[str, List[Dict[str, float]]], key: str
) -> Optional[Dict[str, float]]:
    return combine_stats(extra_metrics.get(key, []))


def recommendation_for_instance(
    instance_cpu: Optional[Dict[str, float]],
    instance_mem: Optional[Dict[str, float]],
    worker_summaries: List[Dict[str, Any]],
    extra_metric_summary: Dict[str, Optional[Dict[str, float]]],
    args: argparse.Namespace,
    worker_count: Optional[int] = None,
) -> List[Dict[str, str]]:
    recs: List[Dict[str, str]] = []
    if not instance_cpu or not instance_mem:
        recs.append(
            {
                "level": "insufficient-data",
                "action": "补齐实例 CPU/内存指标后再评估降配",
                "reason": "实例级 CPU 或内存指标缺失",
            }
        )
        return recs

    cpu_avg = instance_cpu["avg"]
    cpu_p95 = instance_cpu["p95"]
    mem_avg = instance_mem["avg"]
    mem_p95 = instance_mem["p95"]

    if cpu_p95 >= 85 or mem_p95 >= 85:
        recs.append(
            {
                "level": "hold-capacity",
                "action": "保持当前实例规格",
                "reason": f"峰值负载偏高: cpu_p95={cpu_p95:.2f}%, mem_p95={mem_p95:.2f}%",
            }
        )
    elif cpu_avg < 20 and cpu_p95 < 40 and mem_avg < 35 and mem_p95 < 55:
        recs.append(
            {
                "level": "high-confidence-downsize",
                "action": "优先评估实例降配",
                "reason": (
                    f"低负载且稳定: cpu(avg/p95)={cpu_avg:.2f}%/{cpu_p95:.2f}%, "
                    f"mem(avg/p95)={mem_avg:.2f}%/{mem_p95:.2f}%"
                ),
            }
        )
    elif cpu_avg < 35 and cpu_p95 < 60 and mem_avg < 50 and mem_p95 < 70:
        recs.append(
            {
                "level": "medium-confidence-downsize",
                "action": "可评估实例降配",
                "reason": (
                    f"负载整体可控: cpu(avg/p95)={cpu_avg:.2f}%/{cpu_p95:.2f}%, "
                    f"mem(avg/p95)={mem_avg:.2f}%/{mem_p95:.2f}%"
                ),
            }
        )
    else:
        recs.append(
            {
                "level": "observe",
                "action": "暂不建议降配，继续观察",
                "reason": (
                    f"负载接近阈值: cpu(avg/p95)={cpu_avg:.2f}%/{cpu_p95:.2f}%, "
                    f"mem(avg/p95)={mem_avg:.2f}%/{mem_p95:.2f}%"
                ),
            }
        )

    blockers: List[str] = []
    latency_p99 = extra_metric_summary.get("query_latency_p99")
    if latency_p99 and latency_p99["p95"] >= args.latency_p99_threshold_ms:
        blockers.append(
            f"query_latency_p99 p95={latency_p99['p95']:.2f} >= {args.latency_p99_threshold_ms:.2f}ms"
        )

    failed_query_qps = extra_metric_summary.get("failed_query_qps")
    if failed_query_qps and failed_query_qps["p95"] >= args.failed_query_qps_threshold:
        blockers.append(
            "failed_query_qps "
            f"p95={failed_query_qps['p95']:.2f} >= {args.failed_query_qps_threshold:.2f}"
        )

    max_conn_usage = extra_metric_summary.get("max_connection_usage")
    if max_conn_usage and max_conn_usage["p95"] >= args.connection_usage_threshold:
        blockers.append(
            "max_connection_usage "
            f"p95={max_conn_usage['p95']:.2f}% >= {args.connection_usage_threshold:.2f}%"
        )

    if blockers:
        recs.append(
            {
                "level": "safety-blocker",
                "action": "暂缓降配",
                "reason": "；".join(blockers),
            }
        )

    replica_sync_lag = extra_metric_summary.get("replica_sync_lag")
    file_sync_lag = extra_metric_summary.get("file_sync_lag")
    lag_sources = []
    if replica_sync_lag:
        lag_sources.append(f"replica_sync_lag p95={replica_sync_lag['p95']:.2f}")
    if file_sync_lag:
        lag_sources.append(f"file_sync_lag p95={file_sync_lag['p95']:.2f}")
    if lag_sources:
        recs.append(
            {
                "level": "replication-note",
                "action": "校验复制链路稳定性",
                "reason": "；".join(lag_sources),
            }
        )

    hot_storage = extra_metric_summary.get("hot_storage_used_percentage")
    cold_storage = extra_metric_summary.get("cold_storage_used_percentage")
    storage_note = []
    if hot_storage:
        storage_note.append(f"hot_storage_used_percentage p95={hot_storage['p95']:.2f}%")
    if cold_storage:
        storage_note.append(f"cold_storage_used_percentage p95={cold_storage['p95']:.2f}%")
    if storage_note:
        recs.append(
            {
                "level": "storage-note",
                "action": "联合存储容量评估账单优化",
                "reason": "；".join(storage_note),
            }
        )

    # Floor check: if instance likely already at minimum spec, flag it
    if worker_count is not None and worker_count <= HOLOGRES_MIN_SPEC["nodes"]:
        has_downsize = any(
            r["level"] in ("high-confidence-downsize", "medium-confidence-downsize")
            for r in recs
        )
        if has_downsize:
            recs.append(
                {
                    "level": "at-minimum-spec",
                    "action": f"该实例可能已处于最低规格（{HOLOGRES_MIN_SPEC_LABEL}），无法进一步降配",
                    "reason": f"Worker 数量={worker_count}，已 <= 最低规格节点数 {HOLOGRES_MIN_SPEC['nodes']}",
                }
            )

    complete_workers = [
        worker
        for worker in worker_summaries
        if worker.get("cpu") is not None and worker.get("memory") is not None
    ]
    if len(complete_workers) >= 2 and not blockers:
        idle_workers = [
            worker
            for worker in complete_workers
            if worker["cpu"]["avg"] < 15
            and worker["cpu"]["p95"] < 35
            and worker["memory"]["avg"] < 30
            and worker["memory"]["p95"] < 45
        ]
        if (
            len(idle_workers) / len(complete_workers) >= 0.5
            and cpu_p95 < 60
            and mem_p95 < 70
        ):
            recs.append(
                {
                    "level": "node-reduction-candidate",
                    "action": "可评估 Worker 节点缩容",
                    "reason": (
                        f"低负载 Worker 占比 {len(idle_workers)}/{len(complete_workers)}，"
                        "实例整体峰值仍低于风险阈值"
                    ),
                }
            )

        cpu_p95_values = [worker["cpu"]["p95"] for worker in complete_workers]
        if max(cpu_p95_values) - min(cpu_p95_values) >= 35:
            recs.append(
                {
                    "level": "rebalance-before-downsize",
                    "action": "优先处理负载倾斜，再决定降配",
                    "reason": (
                        f"Worker CPU p95 离散度较大: min={min(cpu_p95_values):.2f}%, "
                        f"max={max(cpu_p95_values):.2f}%"
                    ),
                }
            )

    return recs


def recommendation_rank(level: str) -> int:
    order = {
        "safety-blocker": 0,
        "high-confidence-downsize": 1,
        "medium-confidence-downsize": 2,
        "node-reduction-candidate": 3,
        "observe": 4,
        "hold-capacity": 5,
        "rebalance-before-downsize": 6,
        "at-minimum-spec": 7,
        "replication-note": 8,
        "storage-note": 9,
        "insufficient-data": 10,
    }
    return order.get(level, 99)


def format_stats(stats: Optional[Dict[str, float]], suffix: str = "%") -> str:
    if not stats:
        return "-"
    return f"avg={stats['avg']:.2f}{suffix} p95={stats['p95']:.2f}{suffix} max={stats['max']:.2f}{suffix}"


def format_value(stats: Optional[Dict[str, float]], fmt: str = "{:.2f}") -> str:
    if not stats:
        return "-"
    return fmt.format(stats["p95"])


# Actual Hologres spec tiers from Alibaba Cloud console
# Each node = 16 CU / 64 GB
HOLOGRES_SPEC_TIERS = [
    {"cu": 32,  "memory_gb": 128,  "nodes": 2},
    {"cu": 64,  "memory_gb": 256,  "nodes": 4},
    {"cu": 96,  "memory_gb": 384,  "nodes": 6},
    {"cu": 128, "memory_gb": 512,  "nodes": 8},
    {"cu": 160, "memory_gb": 640,  "nodes": 10},
    {"cu": 192, "memory_gb": 768,  "nodes": 12},
    {"cu": 256, "memory_gb": 1024, "nodes": 16},
    {"cu": 384, "memory_gb": 1536, "nodes": 24},
]

HOLOGRES_MIN_SPEC = HOLOGRES_SPEC_TIERS[0]
HOLOGRES_MIN_SPEC_LABEL = f"{HOLOGRES_MIN_SPEC['cu']}CU / {HOLOGRES_MIN_SPEC['memory_gb']}GB / {HOLOGRES_MIN_SPEC['nodes']}节点"

CU_PER_NODE = 16
GB_PER_NODE = 64


def spec_label(spec: Dict[str, Any]) -> str:
    return f"{spec['cu']}CU / {spec['memory_gb']}GB / {spec['nodes']}节点"


def infer_current_spec(worker_count: int) -> Optional[Dict[str, Any]]:
    """Infer current spec from worker (node) count. Returns exact tier or a synthetic one."""
    for tier in HOLOGRES_SPEC_TIERS:
        if tier["nodes"] == worker_count:
            return tier
    if worker_count > 0:
        return {
            "cu": worker_count * CU_PER_NODE,
            "memory_gb": worker_count * GB_PER_NODE,
            "nodes": worker_count,
        }
    return None


def suggest_target_spec(
    cpu_p95: float,
    mem_p95: float,
    current_worker_count: int,
    level: str,
) -> Optional[Dict[str, Any]]:
    """Pick the smallest tier that keeps p95 usage within headroom of new capacity."""
    if level not in ("high-confidence-downsize", "medium-confidence-downsize"):
        return None
    headroom = 0.60 if level == "high-confidence-downsize" else 0.70
    current_total_cu = current_worker_count * CU_PER_NODE
    current_total_gb = current_worker_count * GB_PER_NODE
    abs_cpu = current_total_cu * (cpu_p95 / 100.0)
    abs_mem = current_total_gb * (mem_p95 / 100.0)
    needed_cu = abs_cpu / headroom
    needed_gb = abs_mem / headroom
    for tier in HOLOGRES_SPEC_TIERS:
        if tier["cu"] >= needed_cu and tier["memory_gb"] >= needed_gb:
            if tier["cu"] < current_total_cu:
                return tier
            break
    return None


def _level_emoji(level: str) -> str:
    m = {
        "high-confidence-downsize": "🟢",
        "medium-confidence-downsize": "🟡",
        "safety-blocker": "🔴",
        "hold-capacity": "⚪",
        "observe": "🟠",
        "node-reduction-candidate": "🔵",
        "rebalance-before-downsize": "🟣",
        "at-minimum-spec": "⬛",
        "replication-note": "📝",
        "storage-note": "📦",
        "insufficient-data": "❓",
    }
    return m.get(level, "")


def _build_instance_detail(item: Dict[str, Any], thresholds: Dict[str, float]) -> List[str]:
    """Build per-instance detailed analysis section."""
    lines: List[str] = []
    name = item["instance_name"]
    types = ",".join(item["types"]) if item["types"] else "-"
    lines.append(f"### {name} ({types})")
    lines.append("")

    cpu = item.get("instance_cpu")
    mem = item.get("instance_memory")
    extra = item.get("extra_metrics_summary", {})

    # Capacity overview
    lines.append("**资源利用率**")
    lines.append("")
    lines.append("| 指标 | avg | p50 | p95 | max |")
    lines.append("|---|---:|---:|---:|---:|")
    if cpu:
        lines.append(
            f"| CPU | {cpu['avg']:.2f}% | {cpu['p50']:.2f}% | {cpu['p95']:.2f}% | {cpu['max']:.2f}% |"
        )
    else:
        lines.append("| CPU | - | - | - | - |")
    if mem:
        lines.append(
            f"| Memory | {mem['avg']:.2f}% | {mem['p50']:.2f}% | {mem['p95']:.2f}% | {mem['max']:.2f}% |"
        )
    else:
        lines.append("| Memory | - | - | - | - |")
    lines.append("")

    # Service quality metrics
    qps = extra.get("query_qps")
    fail_qps = extra.get("failed_query_qps")
    lat_p99 = extra.get("query_latency_p99")
    conn = extra.get("max_connection_usage")
    dml = extra.get("dml_rps")
    lines.append("**服务质量指标**")
    lines.append("")
    lines.append("| 指标 | avg | p95 | max | 阈值 | 状态 |")
    lines.append("|---|---:|---:|---:|---:|---|")
    if lat_p99:
        th = thresholds["latency_p99_threshold_ms"]
        status = "🔴 超阈值" if lat_p99["p95"] >= th else "✅ 正常"
        lines.append(
            f"| Query P99 延迟(ms) | {lat_p99['avg']:.2f} | {lat_p99['p95']:.2f} | {lat_p99['max']:.2f} | {th:.0f} | {status} |"
        )
    if fail_qps:
        th = thresholds["failed_query_qps_threshold"]
        status = "🔴 超阈值" if fail_qps["p95"] >= th else "✅ 正常"
        lines.append(
            f"| Failed Query QPS | {fail_qps['avg']:.2f} | {fail_qps['p95']:.2f} | {fail_qps['max']:.2f} | {th:.1f} | {status} |"
        )
    if conn:
        th = thresholds["connection_usage_threshold"]
        status = "🔴 超阈值" if conn["p95"] >= th else "✅ 正常"
        lines.append(
            f"| 连接使用率(%) | {conn['avg']:.2f} | {conn['p95']:.2f} | {conn['max']:.2f} | {th:.0f}% | {status} |"
        )
    if qps:
        lines.append(f"| Query QPS | {qps['avg']:.2f} | {qps['p95']:.2f} | {qps['max']:.2f} | - | - |")
    if dml:
        lines.append(f"| DML RPS | {dml['avg']:.2f} | {dml['p95']:.2f} | {dml['max']:.2f} | - | - |")
    lines.append("")

    # Worker details
    workers = item.get("workers", [])
    if workers:
        complete = [w for w in workers if w.get("cpu") and w.get("memory")]
        lines.append(f"**Worker 节点 ({len(workers)} 个)**")
        lines.append("")
        if complete:
            lines.append("| Worker | CPU avg | CPU p95 | Mem avg | Mem p95 |")
            lines.append("|---|---:|---:|---:|---:|")
            for w in complete:
                lines.append(
                    f"| {w['worker_name']} | {w['cpu']['avg']:.2f}% | {w['cpu']['p95']:.2f}% | {w['memory']['avg']:.2f}% | {w['memory']['p95']:.2f}% |"
                )
            lines.append("")

            cpu_p95s = [w["cpu"]["p95"] for w in complete]
            if len(cpu_p95s) >= 2:
                skew = max(cpu_p95s) - min(cpu_p95s)
                lines.append(
                    f"- 节点 CPU p95 离散度: {skew:.2f}pp (min={min(cpu_p95s):.2f}%, max={max(cpu_p95s):.2f}%)"
                )
                if skew >= 35:
                    lines.append("- ⚠️ 负载倾斜显著，建议先排查热点再决定降配")
                lines.append("")

    # Replication / storage notes
    rep_lag = extra.get("replica_sync_lag")
    file_lag = extra.get("file_sync_lag")
    hot_storage = extra.get("hot_storage_used_percentage")
    cold_storage = extra.get("cold_storage_used_percentage")
    if any([rep_lag, file_lag, hot_storage, cold_storage]):
        lines.append("**复制与存储**")
        lines.append("")
        if rep_lag:
            lines.append(f"- replica_sync_lag: avg={rep_lag['avg']:.2f} p95={rep_lag['p95']:.2f} max={rep_lag['max']:.2f}")
        if file_lag:
            lines.append(f"- file_sync_lag: avg={file_lag['avg']:.2f} p95={file_lag['p95']:.2f} max={file_lag['max']:.2f}")
        if hot_storage:
            lines.append(f"- 热存储使用率: avg={hot_storage['avg']:.2f}% p95={hot_storage['p95']:.2f}% max={hot_storage['max']:.2f}%")
        if cold_storage:
            lines.append(f"- 冷存储使用率: avg={cold_storage['avg']:.2f}% p95={cold_storage['p95']:.2f}% max={cold_storage['max']:.2f}%")
        lines.append("")

    # Current spec
    wc = len(workers) if workers else 0
    current_spec = infer_current_spec(wc)
    if current_spec:
        lines.append("**当前配置（根据 Worker 数推断）**")
        lines.append("")
        lines.append(f"- 规格: **{spec_label(current_spec)}**")
        is_known = any(t["nodes"] == current_spec["nodes"] for t in HOLOGRES_SPEC_TIERS)
        if not is_known:
            lines.append(f"- ⚠️ 当前节点数 {wc} 不在标准规格梯度中，可能是自定义配置")
        is_at_min = current_spec["cu"] <= HOLOGRES_MIN_SPEC["cu"]
        if is_at_min:
            lines.append(f"- ⬛ 已处于最低规格（{HOLOGRES_MIN_SPEC_LABEL}），无法进一步降配")
        lines.append("")

    # Recommendations with reasoning
    recs = item.get("recommendations", [])
    lines.append("**判定结果与依据**")
    lines.append("")
    if not recs:
        lines.append("- 无建议（数据不足）")
    else:
        for rec in recs:
            emoji = _level_emoji(rec["level"])
            lines.append(f"- {emoji} **{rec['level']}**: {rec['action']}")
            lines.append(f"  - 依据: {rec['reason']}")

    # Target spec suggestion
    if cpu and mem and current_spec:
        primary_level = recs[0]["level"] if recs else ""
        target = suggest_target_spec(
            cpu_p95=cpu["p95"],
            mem_p95=mem["p95"],
            current_worker_count=wc if wc > 0 else HOLOGRES_MIN_SPEC["nodes"],
            level=primary_level,
        )
        if target:
            lines.append("")
            lines.append(f"- 📐 建议目标规格: **{spec_label(target)}**")
            lines.append(f"  - 当前: {spec_label(current_spec)} → 目标: {spec_label(target)}")
            saved_cu = current_spec["cu"] - target["cu"]
            if saved_cu > 0:
                lines.append(f"  - 预计可释放: {saved_cu}CU ({saved_cu / current_spec['cu'] * 100:.0f}%)")
        elif primary_level in ("high-confidence-downsize", "medium-confidence-downsize"):
            lines.append("")
            if current_spec["cu"] <= HOLOGRES_MIN_SPEC["cu"]:
                lines.append(f"- 📐 已处于最低规格 **{HOLOGRES_MIN_SPEC_LABEL}**，虽然负载低但无更低规格可选")
            else:
                lines.append("- 📐 未找到比当前更低且满足余量要求的标准规格")

    lines.append("")
    lines.append("---")
    lines.append("")
    return lines


def build_markdown_report(report: Dict[str, Any]) -> str:
    lines: List[str] = []
    window = report["window"]
    summary = report["summary"]
    thresholds = report["thresholds"]

    lines.append("# Hologres 成本优化分析报告")
    lines.append("")
    lines.append("## 概览")
    lines.append("")
    lines.append(f"- 生成时间: {report['generated_at']}")
    lines.append(
        f"- 分析窗口: {window['start_iso']} ~ {window['end_iso']} ({window['hours']}h, step={window['step']})"
    )
    lines.append(f"- Prometheus URL: `{report['source']['prometheus_query_range_url']}`")
    lines.append(f"- 实例总数: {summary['instance_count']}")
    lines.append(f"- 最低规格约束: {HOLOGRES_MIN_SPEC_LABEL}（阿里云 Hologres 实例不可低于此规格）")
    lines.append("")
    lines.append("**分析阈值**")
    lines.append("")
    lines.append(f"- Query P99 延迟阻断阈值: {thresholds['latency_p99_threshold_ms']:.0f}ms")
    lines.append(f"- Failed Query QPS 阻断阈值: {thresholds['failed_query_qps_threshold']:.1f}")
    lines.append(f"- 连接使用率阻断阈值: {thresholds['connection_usage_threshold']:.0f}%")
    lines.append("")

    # Executive summary table
    lines.append("## 汇总")
    lines.append("")
    lines.append("| 类别 | 数量 |")
    lines.append("|---|---:|")
    lines.append(f"| 🟢 高置信降配候选 | {summary['high_confidence_downsize']} |")
    lines.append(f"| 🟡 中置信降配候选 | {summary['medium_confidence_downsize']} |")
    lines.append(f"| 🔴 安全阻断（暂缓降配） | {summary['safety_blocker']} |")
    lines.append(f"| 🔵 节点缩容候选 | {summary['node_reduction_candidate']} |")
    lines.append(f"| ⚪ 保持配置 | {summary['hold_capacity']} |")
    lines.append(f"| ❓ 数据不足 | {summary['insufficient_data']} |")
    lines.append("")

    # Quick action table
    lines.append("## 降配候选一览")
    lines.append("")
    lines.append(
        "| 实例 | 类型 | 当前配置 | CPU(avg/p95) | Mem(avg/p95) | P99延迟 p95 | 判定 | 建议目标 |"
    )
    lines.append("|---|---|---|---:|---:|---:|---|---|")
    for item in report["instances"]:
        extra = item["extra_metrics_summary"]
        cpu = item.get("instance_cpu")
        mem = item.get("instance_memory")
        rec = item["recommendations"][0] if item["recommendations"] else {}
        wc = item.get("worker_count", 0)
        cur_spec = infer_current_spec(wc)
        cur_label = spec_label(cur_spec) if cur_spec else "-"
        cpu_str = f"{cpu['avg']:.1f}%/{cpu['p95']:.1f}%" if cpu else "-"
        mem_str = f"{mem['avg']:.1f}%/{mem['p95']:.1f}%" if mem else "-"
        lat = extra.get("query_latency_p99")
        lat_str = f"{lat['p95']:.0f}ms" if lat else "-"
        level = rec.get("level", "-")
        emoji = _level_emoji(level)

        target_label = "-"
        if cpu and mem and cur_spec:
            target = suggest_target_spec(cpu["p95"], mem["p95"], wc or 2, level)
            if target:
                target_label = spec_label(target)
            elif level in ("high-confidence-downsize", "medium-confidence-downsize"):
                if cur_spec["cu"] <= HOLOGRES_MIN_SPEC["cu"]:
                    target_label = "已是最低规格"
                else:
                    target_label = "无更低规格"

        lines.append(
            f"| {item['instance_name']} | {','.join(item['types']) or '-'} | {cur_label} | {cpu_str} | {mem_str} | {lat_str} | {emoji} {level} | {target_label} |"
        )
    lines.append("")

    # Safety blockers
    blockers = []
    for item in report["instances"]:
        for rec in item["recommendations"]:
            if rec["level"] == "safety-blocker":
                blockers.append((item["instance_name"], rec["reason"]))
    lines.append("## 安全阻断项")
    lines.append("")
    if not blockers:
        lines.append("无阻断项。")
    else:
        for name, reason in blockers:
            lines.append(f"- **{name}**: {reason}")
        lines.append("")
        lines.append("> 存在安全阻断的实例，即使负载低也应暂缓降配，优先解决服务质量问题。")
    lines.append("")

    # Detailed per-instance analysis
    lines.append("## 逐实例详细分析")
    lines.append("")
    for item in report["instances"]:
        lines.extend(_build_instance_detail(item, thresholds))

    # Methodology
    lines.append("## 判定规则说明")
    lines.append("")
    lines.append("| 判定 | CPU 条件 | Memory 条件 | 含义 |")
    lines.append("|---|---|---|---|")
    lines.append("| 🟢 high-confidence-downsize | avg<20% 且 p95<40% | avg<35% 且 p95<55% | 低负载且稳定，优先降配 |")
    lines.append("| 🟡 medium-confidence-downsize | avg<35% 且 p95<60% | avg<50% 且 p95<70% | 负载可控，可评估降配 |")
    lines.append("| 🟠 observe | 介于中置信与保持之间 | 同左 | 暂不建议降配，继续观察 |")
    lines.append("| ⚪ hold-capacity | p95>=85% | p95>=85% | 峰值偏高，保持配置 |")
    lines.append("| 🔴 safety-blocker | - | - | 延迟/错误/连接率超阈值，暂缓降配 |")
    lines.append("| ⬛ at-minimum-spec | - | - | 已处于最低规格（32CU/128GB/2节点），无法进一步降配 |")
    lines.append("")
    lines.append(f"**最低规格约束**: 阿里云 Hologres 实例最低规格为 **{HOLOGRES_MIN_SPEC_LABEL}**，降配不可低于此规格。")
    lines.append("")

    # Notes
    lines.append("## 注意事项")
    lines.append("")
    lines.append("1. 本报告基于 Prometheus 指标的统计分析，不代表最终降配决策，需结合业务侧确认。")
    lines.append("2. 建议至少覆盖 **24h + 7d** 两个分析窗口，确保覆盖工作日/周末、日间/夜间峰值。")
    lines.append("3. 连接使用率/失败 Query QPS/P99 延迟达到阈值时，优先稳态治理而非降配。")
    lines.append("4. 若出现复制延迟指标升高，先确认主从链路和容灾目标。")
    lines.append("5. 降配前应确认是否有容量增长计划、临时大促或批处理任务高峰。")
    lines.append("6. Worker 负载倾斜显著的实例应先调优数据分布，再考虑降配。")
    lines.append("")

    if report["query_warnings"]:
        lines.append("## 数据采集告警")
        lines.append("")
        for warn in report["query_warnings"]:
            lines.append(f"- {warn}")
        lines.append("")

    return "\n".join(lines)


def main() -> int:
    args = parse_args()
    end_ts = args.end_ts if args.end_ts is not None else int(dt.datetime.now().timestamp())
    start_ts = args.start_ts if args.start_ts is not None else int(end_ts - args.hours * 3600)
    if start_ts >= end_ts:
        print("ERROR: start-ts must be smaller than end-ts", file=sys.stderr)
        return 2

    instance_pattern = re.compile(args.instance_regex) if args.instance_regex else None
    instances: Dict[str, Dict[str, Any]] = {}
    query_warnings: List[str] = []

    for metric_name in DEFAULT_METRICS:
        query = f"{metric_name}{{}}"
        try:
            series = query_range(
                prom_url=args.prom_url,
                query=query,
                start_ts=start_ts,
                end_ts=end_ts,
                step=args.step,
                timeout=args.timeout,
            )
        except (urllib.error.URLError, TimeoutError, RuntimeError, json.JSONDecodeError) as exc:
            query_warnings.append(f"{metric_name}: query failed: {exc}")
            continue

        if not series:
            query_warnings.append(f"{metric_name}: empty result")
            continue

        for one in series:
            labels = one.get("metric", {})
            instance_name = infer_instance_name(labels)
            if instance_pattern and not instance_pattern.search(instance_name):
                continue
            stats = build_stats(one.get("values", []))
            if not stats:
                continue
            append_metric(instances, metric_name, labels, stats)

    analyzed_instances: List[Dict[str, Any]] = []
    for instance_name, data in instances.items():
        instance_cpu = combine_stats(data["instance_metrics"]["cpu"])
        instance_mem = combine_stats(data["instance_metrics"]["memory"])

        workers: List[Dict[str, Any]] = []
        for worker_name, worker_data in data["worker_metrics"].items():
            worker_cpu = combine_stats(worker_data["cpu"])
            worker_mem = combine_stats(worker_data["memory"])
            workers.append(
                {
                    "worker_name": worker_name,
                    "cpu": worker_cpu,
                    "memory": worker_mem,
                }
            )
        workers.sort(key=lambda item: item["worker_name"])

        extra_metric_summary: Dict[str, Optional[Dict[str, float]]] = {}
        for kind in sorted(data["extra_metrics"].keys()):
            extra_metric_summary[kind] = get_extra(data["extra_metrics"], kind)

        recs = recommendation_for_instance(
            instance_cpu=instance_cpu,
            instance_mem=instance_mem,
            worker_summaries=workers,
            extra_metric_summary=extra_metric_summary,
            args=args,
            worker_count=len(workers),
        )
        recs.sort(key=lambda item: recommendation_rank(item["level"]))
        analyzed_instances.append(
            {
                "instance_name": instance_name,
                "instance_ids": sorted(data["instance_ids"]),
                "types": sorted(t for t in data["types"] if t != "mixed"),
                "instance_cpu": instance_cpu,
                "instance_memory": instance_mem,
                "worker_count": len(workers),
                "workers": workers,
                "extra_metrics_summary": extra_metric_summary,
                "recommendations": recs,
            }
        )

    analyzed_instances.sort(
        key=lambda item: (
            recommendation_rank(
                item["recommendations"][0]["level"] if item["recommendations"] else "insufficient-data"
            ),
            item["instance_name"],
        )
    )

    summary = {
        "instance_count": len(analyzed_instances),
        "high_confidence_downsize": 0,
        "medium_confidence_downsize": 0,
        "safety_blocker": 0,
        "node_reduction_candidate": 0,
        "hold_capacity": 0,
        "at_minimum_spec": 0,
        "insufficient_data": 0,
    }
    for item in analyzed_instances:
        levels = {rec["level"] for rec in item["recommendations"]}
        if "high-confidence-downsize" in levels:
            summary["high_confidence_downsize"] += 1
        if "medium-confidence-downsize" in levels:
            summary["medium_confidence_downsize"] += 1
        if "safety-blocker" in levels:
            summary["safety_blocker"] += 1
        if "node-reduction-candidate" in levels:
            summary["node_reduction_candidate"] += 1
        if "hold-capacity" in levels:
            summary["hold_capacity"] += 1
        if "at-minimum-spec" in levels:
            summary["at_minimum_spec"] += 1
        if "insufficient-data" in levels:
            summary["insufficient_data"] += 1

    generated_at = dt.datetime.now(dt.timezone.utc).astimezone().isoformat(timespec="seconds")
    window_start = dt.datetime.fromtimestamp(start_ts, tz=dt.timezone.utc).astimezone()
    window_end = dt.datetime.fromtimestamp(end_ts, tz=dt.timezone.utc).astimezone()
    report = {
        "generated_at": generated_at,
        "source": {"prometheus_query_range_url": args.prom_url},
        "window": {
            "start_ts": start_ts,
            "end_ts": end_ts,
            "start_iso": window_start.isoformat(timespec="seconds"),
            "end_iso": window_end.isoformat(timespec="seconds"),
            "hours": round((end_ts - start_ts) / 3600, 2),
            "step": args.step,
        },
        "thresholds": {
            "latency_p99_threshold_ms": args.latency_p99_threshold_ms,
            "failed_query_qps_threshold": args.failed_query_qps_threshold,
            "connection_usage_threshold": args.connection_usage_threshold,
        },
        "metrics_queried": DEFAULT_METRICS,
        "query_warnings": query_warnings,
        "summary": summary,
        "instances": analyzed_instances,
    }

    output_json = Path(args.output_json)
    output_md = Path(args.output_md)
    output_json.parent.mkdir(parents=True, exist_ok=True)
    output_md.parent.mkdir(parents=True, exist_ok=True)

    output_json.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    output_md.write_text(build_markdown_report(report), encoding="utf-8")

    print(f"Analyzed instances: {summary['instance_count']}")
    print(f"High-confidence downsize: {summary['high_confidence_downsize']}")
    print(f"Medium-confidence downsize: {summary['medium_confidence_downsize']}")
    print(f"Safety blocker: {summary['safety_blocker']}")
    print(f"Node reduction candidate: {summary['node_reduction_candidate']}")
    print(f"Hold capacity: {summary['hold_capacity']}")
    print(f"Insufficient data: {summary['insufficient_data']}")
    print(f"JSON report: {output_json}")
    print(f"Markdown report: {output_md}")
    if query_warnings:
        print(f"Warnings: {len(query_warnings)} (see report)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
