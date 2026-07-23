"""Soumu Ministry population data -> prefecture rollout order ranking.

See: docs/kokuho data nationwide rollout design docs (2026-07-19, phase2 addendum 2026-07-24).

Primary source: data/raw/population/001023712.xlsx (Ministry of Internal Affairs
and Communications, as of 2025-01-01 / Reiwa 7).
  Sheet: total population by prefecture (Japanese + foreign residents).
  Rows 1-6 are headers, row 7 is the nationwide total (code column is "-"),
  so data starts at row 8 (1-indexed) which is min_row=7 in 0-based openpyxl terms.
  The first 2 digits of the entity code column are used as prefectureCode,
  matching src/data/municipalities/master.json's prefectureCode format.

Three prefectures already validated by the kokuho auto-collection pipeline
(Fukushima, Osaka, Miyagi; see scripts/kokuho/prefectures.json) are marked
pipelineStatus "verified_pilot" regardless of population rank.

Usage:
    python scripts/population/build_prefecture_ranking.py
"""
import json
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parents[2]
SOURCE_XLSX = ROOT / "data" / "raw" / "population" / "001023712.xlsx"
OUT_PATH = ROOT / "scripts" / "kokuho" / "prefecture_rollout_order.json"

SHEET_NAME = "人口、世帯数、人口動態（都道府県別）【総計】"
DATA_START_ROW = 7

VERIFIED_PILOT_PREFECTURE_CODES = {"07", "27", "04"}


def build_ranking(wb):
    ws = wb[SHEET_NAME]
    entries = []
    for row in ws.iter_rows(min_row=DATA_START_ROW, values_only=True):
        raw_code = row[0]
        name = row[1]
        population = row[4]
        if raw_code is None or raw_code == "-" or population is None:
            continue  # 全国合計行、および注釈行(団体コード列に文字列が入り人口が空)を除外
        prefecture_code = str(raw_code)[:2]
        entries.append(
            {
                "prefectureCode": prefecture_code,
                "prefecture": name,
                "population": population,
            }
        )

    entries.sort(key=lambda e: e["population"], reverse=True)

    order = []
    rank = 1
    for entry in entries:
        if entry["prefectureCode"] in VERIFIED_PILOT_PREFECTURE_CODES:
            pipeline_status = "verified_pilot"
        else:
            pipeline_status = "not_started"
        order.append(
            {
                "rank": rank,
                "prefectureCode": entry["prefectureCode"],
                "prefecture": entry["prefecture"],
                "population": entry["population"],
                "pipelineStatus": pipeline_status,
            }
        )
        rank += 1
    return order


def main():
    wb = openpyxl.load_workbook(SOURCE_XLSX, data_only=True)
    order = build_ranking(wb)

    if len(order) != 47:
        raise ValueError("prefecture count is not 47: %d" % len(order))

    pilot_count = 0
    for e in order:
        if e["pipelineStatus"] == "verified_pilot":
            pilot_count += 1
    if pilot_count != len(VERIFIED_PILOT_PREFECTURE_CODES):
        raise ValueError(
            "verified_pilot count mismatch: %d (expected %d)"
            % (pilot_count, len(VERIFIED_PILOT_PREFECTURE_CODES))
        )

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "description": "人口降順の都道府県展開順序。docs/国保料データ全国展開_設計方針_2026-07-19.md フェーズ2に基づく。",
        "source": "data/raw/population/source.json",
        "order": order,
    }
    OUT_PATH.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print("[build_prefecture_ranking] %s: %d entries" % (OUT_PATH.relative_to(ROOT), len(order)))
    for e in order[:5]:
        print("  %d. %s (%s) [%s]" % (e["rank"], e["prefecture"], format(e["population"], ","), e["pipelineStatus"]))


if __name__ == "__main__":
    main()
