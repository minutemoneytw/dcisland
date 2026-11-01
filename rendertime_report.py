#!/usr/bin/env python3
"""rendertime report：根據 render-times.jsonl 產生繁體中文渲染報告。

依據 LOG_FORMAT.md（media 1.51.0）：
  rendertime report [--days 7] [--log "PATH"]

- 預設讀 /home/box/shared-docs/logs/render-times.jsonl，若超過 5 MB 會 rotate 成
  render-times.jsonl.1，report 要兩份都讀。
- 壞掉的行（JSON 解不開、缺欄位）要略過，不能讓 report 失敗。
- 輸出繁體中文報告：指令/階段統計、渲染比（秒／成片分鐘）、尖峰負載（load_peak + nproc）、
  重疊（concurrent_jobs）。
- 只用標準函式庫，不連網。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone

DEFAULT_LOG = "/home/box/shared-docs/logs/render-times.jsonl"
DEFAULT_DAYS = 7
ROTATED_SUFFIX = ".1"
TAIPEI_TZ = timezone(timedelta(hours=8))


def default_log_path() -> str:
    return os.environ.get("RENDERTIME_LOG") or DEFAULT_LOG


def rotated_log_path(log_path: str) -> str:
    return log_path + ROTATED_SUFFIX


def log_candidates(log_path: str):
    candidates = [log_path]
    rotated = rotated_log_path(log_path)
    if os.path.exists(rotated):
        candidates.append(rotated)
    return candidates


def parse_ts(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("missing or invalid ts")
    dt = datetime.fromisoformat(value.strip())
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=TAIPEI_TZ)
    return dt


def normalize(obj):
    """把 JSON 行正規成內部用 row dict；欄位缺失或型別錯誤回傳 None（視為壞行）。"""
    if not isinstance(obj, dict):
        return None
    v = obj.get("v")
    if isinstance(v, bool) or not isinstance(v, int):
        return None
    command = obj.get("command")
    stage = obj.get("stage")
    wall_seconds = obj.get("wall_seconds")
    ok = obj.get("ok")
    if not isinstance(command, str) or not command.strip():
        return None
    if not isinstance(stage, str) or not stage.strip():
        return None
    if isinstance(wall_seconds, bool) or not isinstance(wall_seconds, (int, float)):
        return None
    if not isinstance(ok, bool):
        return None
    try:
        ts = parse_ts(obj.get("ts"))
        end_ts = parse_ts(obj.get("end_ts"))
    except (ValueError, TypeError):
        return None

    stages = obj.get("stages")
    clean_stages = {}
    if isinstance(stages, dict):
        for k, val in stages.items():
            if isinstance(val, (int, float)) and not isinstance(val, bool):
                clean_stages[str(k)] = float(val)

    output_seconds = obj.get("output_seconds")
    if isinstance(output_seconds, bool) or not isinstance(output_seconds, (int, float)):
        output_seconds = None

    load_peak = obj.get("load_peak")
    if isinstance(load_peak, bool) or not isinstance(load_peak, (int, float)):
        load_peak = 0.0

    nproc = obj.get("nproc")
    if isinstance(nproc, bool) or not isinstance(nproc, int) or nproc < 0:
        nproc = 0

    concurrent_jobs = obj.get("concurrent_jobs")
    if (
        isinstance(concurrent_jobs, bool)
        or not isinstance(concurrent_jobs, int)
        or concurrent_jobs < 0
    ):
        concurrent_jobs = 0

    exit_code = obj.get("exit_code")
    if isinstance(exit_code, bool) or not isinstance(exit_code, int):
        exit_code = None

    pid = obj.get("pid")
    if isinstance(pid, bool) or not isinstance(pid, int):
        pid = None

    def _str(key):
        val = obj.get(key)
        return val if isinstance(val, str) else None

    return {
        "v": v,
        "ts": ts,
        "end_ts": end_ts,
        "command": command,
        "stage": stage,
        "stages": clean_stages,
        "cwd": obj.get("cwd") if isinstance(obj.get("cwd"), str) else "",
        "project": _str("project"),
        "series": _str("series"),
        "user": _str("user"),
        "output": _str("output"),
        "output_seconds": float(output_seconds) if output_seconds is not None else None,
        "wall_seconds": float(wall_seconds),
        "ok": ok,
        "exit_code": exit_code,
        "load_peak": float(load_peak),
        "nproc": int(nproc),
        "concurrent_jobs": int(concurrent_jobs),
        "pid": pid,
        "host": obj.get("host") if isinstance(obj.get("host"), str) else "",
    }


def read_jsonl(path):
    rows = []
    bad = 0
    if not os.path.exists(path):
        return rows, 0
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            stripped = line.strip()
            if not stripped:
                bad += 1
                continue
            try:
                obj = json.loads(stripped)
                row = normalize(obj)
            except Exception:
                bad += 1
                continue
            if row is None:
                bad += 1
                continue
            rows.append(row)
    return rows, bad


def collect_rows(log_paths, days=DEFAULT_DAYS):
    rows = []
    bad = 0
    for path in log_paths:
        file_rows, file_bad = read_jsonl(path)
        rows.extend(file_rows)
        bad += file_bad
    if days is None or days <= 0:
        return rows, bad
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    kept = [r for r in rows if r["ts"] >= cutoff]
    return kept, bad


def aggregate(rows):
    commands = {}
    stages = {}
    peak_load = None
    peak_nproc = 0
    overlap_count = 0
    ok_wall = 0.0
    ok_output = 0.0

    for r in rows:
        cmd = r["command"]
        cs = commands.setdefault(
            cmd,
            {
                "command": cmd,
                "count": 0,
                "wall_seconds": 0.0,
                "ok": 0,
                "fail": 0,
                "output_seconds": 0.0,
                "ok_wall_seconds": 0.0,
                "ok_output_seconds": 0.0,
            },
        )
        cs["count"] += 1
        cs["wall_seconds"] += r["wall_seconds"]
        if r["ok"]:
            cs["ok"] += 1
            if r["output_seconds"] is not None:
                cs["ok_wall_seconds"] += r["wall_seconds"]
                cs["ok_output_seconds"] += r["output_seconds"]
        else:
            cs["fail"] += 1
        if r["output_seconds"] is not None:
            cs["output_seconds"] += r["output_seconds"]

        skey = (cmd, r["stage"])
        st = stages.setdefault(
            skey,
            {"command": cmd, "stage": r["stage"], "count": 0, "seconds": 0.0},
        )
        st["count"] += 1
        st["seconds"] += r["wall_seconds"]
        if r["stage"] == "total":
            for step, secs in r["stages"].items():
                s2 = stages.setdefault(
                    (cmd, step),
                    {"command": cmd, "stage": step, "count": 0, "seconds": 0.0},
                )
                s2["count"] += 1
                s2["seconds"] += secs

        if r["load_peak"] is not None and (peak_load is None or r["load_peak"] > peak_load):
            peak_load = r["load_peak"]
            peak_nproc = r["nproc"]
        if r["concurrent_jobs"] and r["concurrent_jobs"] > 0:
            overlap_count += 1
        if r["ok"] and r["output_seconds"] is not None:
            ok_wall += r["wall_seconds"]
            ok_output += r["output_seconds"]

    total = len(rows)
    overlap_ratio = (overlap_count / total * 100.0) if total else 0.0
    render_ratio = (ok_wall / (ok_output / 60.0)) if ok_output and ok_output > 0 else None

    for cs in commands.values():
        cs["render_ratio"] = (
            cs["ok_wall_seconds"] / (cs["ok_output_seconds"] / 60.0)
            if cs["ok_output_seconds"] and cs["ok_output_seconds"] > 0
            else None
        )

    return {
        "rows": total,
        "commands": commands,
        "stages": stages,
        "peak_load": peak_load if peak_load is not None else 0.0,
        "peak_nproc": peak_nproc,
        "overlap_count": overlap_count,
        "overlap_ratio": overlap_ratio,
        "render_ratio": render_ratio,
    }


def _as_dt(value):
    if isinstance(value, datetime):
        return value
    return parse_ts(value)


def time_range(rows):
    if not rows:
        return "N/A"
    starts = [_as_dt(r["ts"]) for r in rows]
    ends = [_as_dt(r["end_ts"]) for r in rows]
    return "%s ~ %s" % (min(starts).strftime("%Y-%m-%d %H:%M"), max(ends).strftime("%Y-%m-%d %H:%M"))


def _fmt_num(x, nd=2):
    if x is None:
        return "N/A"
    return f"{x:.{nd}f}"


def generate_report(rows, source="render-times.jsonl", bad_lines=0, days=DEFAULT_DAYS):
    agg = aggregate(rows)
    lines = []
    add = lines.append
    add("=" * 64)
    add("              渲染時間報告")
    add("              rendertime report")
    add("=" * 64)
    add("")
    add(f"資料來源        : {source}")
    add(f"統計天數        : {days}")
    add(f"有效資料筆數    : {agg['rows']}")
    add(f"跳過壞行        : {bad_lines}")
    add(f"資料時間範圍    : {time_range(rows)}")
    add("")
    add("【指令統計】(依指令)")
    add("-" * 70)
    add("指令              次數      總秒數     成功      失敗      輸出秒數(秒)    渲染比(秒/分鐘)")
    for cmd in sorted(agg["commands"]):
        c = agg["commands"][cmd]
        add(
            f"{cmd:<18}{c['count']:>8}{c['wall_seconds']:>12.2f}{c['ok']:>6}{c['fail']:>6}"
            f"{c['output_seconds']:>14.2f}{_fmt_num(c['render_ratio']):>16}"
        )
    add("")
    add("【分階段統計】(依指令與階段)")
    add("-" * 70)
    add("指令              階段            次數       秒數")
    for key in sorted(agg["stages"], key=lambda k: (k[0], k[1])):
        st = agg["stages"][key]
        add(f"{st['command']:<18}{st['stage']:<14}{st['count']:>8}{st['seconds']:>12.2f}")
    add("")
    add("【尖峰負載】")
    add("-" * 70)
    add(f"最高 load_peak    : {_fmt_num(agg['peak_load'])}")
    add(f"nproc             : {agg['peak_nproc']}")
    add("")
    add("【重疊】")
    add("-" * 70)
    add(f"重疊筆數          : {agg['overlap_count']}")
    add(f"重疊比例          : {agg['overlap_ratio']:.2f}%")
    add("")
    if not rows:
        add("（無有效資料）")
    return "\n".join(lines)


def build_parser():
    parser = argparse.ArgumentParser(
        prog="rendertime",
        description="根據 render-times.jsonl 產生繁體中文渲染報告",
    )
    subparsers = parser.add_subparsers(dest="command")
    report_parser = subparsers.add_parser("report", help="產生渲染時間報告")
    report_parser.add_argument(
        "--days",
        type=int,
        default=DEFAULT_DAYS,
        help="僅統計最近 N 天（預設 7）",
    )
    report_parser.add_argument(
        "--log",
        default=None,
        help="render-times.jsonl 路徑（預設 /home/box/shared-docs/logs/render-times.jsonl）",
    )
    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command != "report":
        parser.print_help()
        return 2
    log_path = args.log or default_log_path()
    rows, bad = collect_rows(log_candidates(log_path), days=args.days)
    text = generate_report(rows, source=log_path, bad_lines=bad, days=args.days)
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
