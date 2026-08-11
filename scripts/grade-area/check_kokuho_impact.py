"""Report how many of the existing kokuho-confirmed municipalities
(src/data/municipalities/index.json, nationalHealthInsuranceStatus ==
"confirmed") now resolve to a non-default grade (1 or 2) instead of the
previous universal default (3), now that grade-area.json's exceptions are
populated. This is a coarse municipality-level impact measure (does the
均等割 non-taxation threshold coefficient change at all for this
municipality), not a per-taxpayer-income determination.

Only "confirmed" entries are counted, not the small number of
"not_available" ones (currently 3: Tokyo's 利島村・御蔵島村・青ヶ島村, which
have no usable kokuho rate data due to a negative-theoretical-rate
validation failure documented in CLAUDE.md -- unrelated to grade-area, so
they're excluded from this specific "does the calculation change" question).

Usage:
    python scripts/grade-area/check_kokuho_impact.py
"""
import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
INDEX_PATH = ROOT / "src" / "data" / "municipalities" / "index.json"
GRADE_AREA_PATH = ROOT / "src" / "data" / "municipalities" / "grade-area.json"

DENSE_PREFS = {
    "13": "東京都", "14": "神奈川県", "27": "大阪府", "23": "愛知県",
    "11": "埼玉県", "12": "千葉県", "28": "兵庫県", "40": "福岡県"
}


def parse_grade_area_code(raw):
    return int(raw.split("-")[0])


def resolve(pref_code, muni_code, ga):
    pref_entry = ga["prefectures"].get(pref_code)
    raw = pref_entry["exceptions"].get(muni_code) if pref_entry else None
    if raw is not None:
        return parse_grade_area_code(raw), "registered"
    return ga["defaultGrade"], "unregistered"


def main():
    index = json.loads(INDEX_PATH.read_text(encoding="utf-8"))
    ga = json.loads(GRADE_AREA_PATH.read_text(encoding="utf-8"))

    confirmed = [m for m in index["municipalities"] if m.get("nationalHealthInsuranceStatus") == "confirmed"]
    print("confirmed kokuho municipalities:", len(confirmed))

    changed = []
    by_pref_change = Counter()
    by_pref_total = Counter()
    grade_counter = Counter()

    for m in confirmed:
        code = m["municipalityCode"]
        pref_code = code[:2]
        by_pref_total[pref_code] += 1
        grade, status = resolve(pref_code, code, ga)
        grade_counter[grade] += 1
        if status == "registered":
            changed.append((pref_code, code, grade))
            by_pref_change[pref_code] += 1

    print("changed (now grade 1 or 2 instead of default 3):", len(changed))
    print("grade distribution among confirmed:", dict(grade_counter))

    print("\n=== the 8 prefectures with dense 1級地 concentration ===")
    dense_total = dense_changed = 0
    for pc, name in DENSE_PREFS.items():
        total = by_pref_total.get(pc, 0)
        ch = by_pref_change.get(pc, 0)
        dense_total += total
        dense_changed += ch
        print(f"{name}({pc}): confirmed={total} changed={ch}")
    print(f"8-prefecture subtotal: confirmed={dense_total} changed={dense_changed}")

    print("\n=== other prefectures with any change ===")
    for pc in sorted(by_pref_change):
        if pc in DENSE_PREFS:
            continue
        print(f"{pc}: confirmed={by_pref_total.get(pc, 0)} changed={by_pref_change[pc]}")


if __name__ == "__main__":
    main()
