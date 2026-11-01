"""test_rendertime_report.py：rendertime report 的 pytest 測試（使用 tmp_path 合成 log）。"""

import json
from datetime import datetime, timedelta, timezone

import pytest

from rendertime_report import (
    aggregate,
    collect_rows,
    generate_report,
    main,
    normalize,
)

TAIPEI = timezone(timedelta(hours=8))


def make_row(
    command="longvideo build",
    stage="total",
    wall_seconds=100.0,
    ok=True,
    output_seconds=90.0,
    load_peak=2.5,
    nproc=4,
    concurrent_jobs=0,
    ts_value=None,
    end_ts_value=None,
    stages=None,
    exit_code=0,
):
    return {
        "v": 1,
        "ts": ts_value or datetime.now(TAIPEI).isoformat(),
        "end_ts": end_ts_value or (datetime.now(TAIPEI) + timedelta(seconds=10)).isoformat(),
        "command": command,
        "stage": stage,
        "stages": stages if stages is not None else {},
        "cwd": "/data/flint",
        "project": None,
        "series": None,
        "user": "flint",
        "output": None,
        "output_seconds": output_seconds,
        "wall_seconds": wall_seconds,
        "ok": ok,
        "exit_code": exit_code,
        "load_peak": load_peak,
        "nproc": nproc,
        "concurrent": {"ffmpeg": 1, "chromium": 0, "hyperframes": 0},
        "concurrent_jobs": concurrent_jobs,
        "pid": 1234,
        "host": "box",
    }


def row_to_line(obj):
    return json.dumps(obj, ensure_ascii=False)


def write_log(tmp_path, lines):
    p = tmp_path / "render-times.jsonl"
    p.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return p


# ---------- normalize ----------

def test_normalize_accepts_valid_row():
    assert normalize(make_row()) is not None


def test_normalize_rejects_missing_fields():
    row = make_row()
    bad = {k: v for k, v in row.items() if k != "wall_seconds"}
    assert normalize(bad) is None
    assert normalize({"v": 1, "command": "x"}) is None
    assert normalize([1, 2, 3]) is None


# ---------- collect_rows / bad lines ----------

def test_collect_rows_skips_bad_lines(tmp_path):
    good = make_row(command="s2 build", wall_seconds=50.0)
    lines = [
        row_to_line(good),
        "{這是一行壞掉的 JSON",
        row_to_line({"v": 1, "command": "x"}),
    ]
    p = write_log(tmp_path, lines)
    rows, bad = collect_rows([str(p)], days=0)
    assert len(rows) == 1
    assert bad == 2
    assert rows[0]["command"] == "s2 build"


def test_collect_rows_reads_rotated_file(tmp_path):
    good = make_row(command="broll render")
    p = tmp_path / "render-times.jsonl"
    p.write_text("{壞掉\n", encoding="utf-8")
    rotated = tmp_path / "render-times.jsonl.1"
    rotated.write_text(row_to_line(good), encoding="utf-8")
    rows, bad = collect_rows([str(p), str(rotated)], days=0)
    assert len(rows) == 1
    assert rows[0]["command"] == "broll render"
    assert bad == 1


def test_collect_rows_days_filter(tmp_path):
    recent = make_row(command="charts", ts_value=datetime.now(TAIPEI).isoformat())
    old = make_row(
        command="charts",
        ts_value=(datetime.now(TAIPEI) - timedelta(days=10)).isoformat(),
    )
    p = write_log(tmp_path, [row_to_line(recent), row_to_line(old)])
    rows, bad = collect_rows([str(p)], days=7)
    assert len(rows) == 1
    assert rows[0]["command"] == "charts"


# ---------- aggregate ----------

def test_command_and_stage_totals():
    rows = [
        make_row(
            command="longvideo build",
            wall_seconds=66.8,
            ok=True,
            stages={"tts": 12.3, "render": 45.6, "concat": 8.9},
            output_seconds=150.0,
        ),
        make_row(command="longvideo build", stage="total", wall_seconds=30.0, ok=False, stages={}),
    ]
    agg = aggregate(rows)
    cmd = agg["commands"]["longvideo build"]
    assert cmd["count"] == 2
    assert cmd["wall_seconds"] == pytest.approx(96.8)
    assert cmd["ok"] == 1
    assert cmd["fail"] == 1

    assert agg["stages"][("longvideo build", "tts")]["seconds"] == pytest.approx(12.3)
    assert agg["stages"][("longvideo build", "render")]["seconds"] == pytest.approx(45.6)
    assert agg["stages"][("longvideo build", "concat")]["seconds"] == pytest.approx(8.9)
    assert agg["stages"][("longvideo build", "total")]["seconds"] == pytest.approx(96.8)


def test_render_ratio_seconds_per_output_minute():
    rows = [make_row(wall_seconds=180.0, ok=True, output_seconds=90.0)]
    agg = aggregate(rows)
    # 180 秒花在 90 秒輸出上 => 180 / (90/60) = 120 秒／成片分鐘
    assert agg["render_ratio"] == pytest.approx(120.0)
    cmd = agg["commands"]["longvideo build"]
    assert cmd["render_ratio"] == pytest.approx(120.0)


# ---------- peak load / overlap ----------

def test_peak_load_and_nproc():
    rows = [
        make_row(load_peak=1.5, nproc=4),
        make_row(load_peak=3.5, nproc=8),
    ]
    agg = aggregate(rows)
    assert agg["peak_load"] == pytest.approx(3.5)
    assert agg["peak_nproc"] == 8


def test_overlap_count_and_ratio():
    rows = [
        make_row(concurrent_jobs=0),
        make_row(concurrent_jobs=2),
        make_row(concurrent_jobs=0),
    ]
    agg = aggregate(rows)
    assert agg["overlap_count"] == 1
    assert agg["overlap_ratio"] == pytest.approx(100.0 / 3.0)


# ---------- report text ----------

def test_generate_report_contains_sections():
    rows = [make_row(command="longvideo build", wall_seconds=66.8, ok=True, output_seconds=150.0)]
    text = generate_report(rows, source="render-times.jsonl", bad_lines=1, days=7)
    assert "渲染時間報告" in text
    assert "longvideo build" in text
    assert "66.80" in text
    assert "26.72" in text


# ---------- main / CLI ----------

def test_main_report_end_to_end(tmp_path, capsys):
    p = write_log(
        tmp_path,
        [
            row_to_line(make_row(command="longvideo build", wall_seconds=66.8, ok=True, output_seconds=150.0)),
            "{bad json",
        ],
    )
    rc = main(["report", "--log", str(p), "--days", "0"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "渲染時間報告" in out
    assert "longvideo build" in out
    assert "跳過壞行" in out
