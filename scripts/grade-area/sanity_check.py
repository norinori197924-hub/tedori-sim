"""Structural sanity check for src/data/municipalities/grade-area.json:
every exception code must exist in master.json, belong to the prefecture
it's filed under, and use a valid "N-M" level string. Also prints the
resolved grade for a few representative municipalities as a spot-check.

This is a plain-Python structural check, not a substitute for
test/calc/grade-area.test.mjs or resident-tax.test.mjs (which exercise the
actual src/calc/*.js functions under node --test). Run those for behavioral
correctness; run this for quick data-integrity verification without needing
Node installed.

Usage:
    python scripts/grade-area/sanity_check.py
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GRADE_AREA_PATH = ROOT / "src" / "data" / "municipalities" / "grade-area.json"
MASTER_PATH = ROOT / "src" / "data" / "municipalities" / "master.json"

LEVEL_RE = re.compile(r"^[1-3]-[1-2]$")


def parse_grade_area_code(raw):
    head = int(raw.split("-")[0])
    assert head in (1, 2, 3)
    return head


def resolve_grade_area(pref_code, muni_code, data):
    pref_entry = data["prefectures"].get(pref_code)
    raw = pref_entry["exceptions"].get(muni_code) if pref_entry else None
    if raw is not None:
        return parse_grade_area_code(raw), "registered"
    return data["defaultGrade"], "unregistered"


def main():
    ga = json.loads(GRADE_AREA_PATH.read_text(encoding="utf-8"))
    master = json.loads(MASTER_PATH.read_text(encoding="utf-8"))
    valid_codes = {m["code"] for m in master["municipalities"]}

    errors = []
    for pc, entry in ga["prefectures"].items():
        for code, level in entry["exceptions"].items():
            if code not in valid_codes:
                errors.append(f"unknown municipality code: {code}")
            if not LEVEL_RE.match(level):
                errors.append(f"invalid level format: {code} -> {level}")
            if not code.startswith(pc):
                errors.append(f"code {code} does not belong to prefecture {pc}")

    print("errors:", len(errors))
    for e in errors:
        print(" ", e)

    samples = [
        ("13", "13101", "千代田区(東京都特別区)"),
        ("14", "14100", "横浜市(政令市、区展開なし)"),
        ("27", "27100", "大阪市(政令市、区展開なし)"),
        ("13", "13305", "日の出町(3級地デフォルト)"),
    ]
    print()
    for pc, mc, label in samples:
        grade, status = resolve_grade_area(pc, mc, ga)
        print(f"{label} -> grade={grade} status={status}")


if __name__ == "__main__":
    main()
