"""Match parsed grade-area entries (see extract_tables.py) against
src/data/municipalities/master.json and write the result into
src/data/municipalities/grade-area.json.

Design notes:
- Only levels 1-1/1-2/2-1/2-2 are written as exceptions. 3級地(3-1/3-2) is the
  defaultGrade, so recording it explicitly would be redundant (CLAUDE.md
  11.14). Matching failures in a skipped level are therefore harmless even if
  never resolved.
- "区の存する地域" (an aggregate phrase meaning "the area comprising the
  special wards") is expanded to Tokyo's 23 individual 特別区 codes, because
  unlike a 政令指定都市's wards, Tokyo's special wards ARE independent basic
  local governments with their own JIS codes in master.json. A designated
  city (e.g. 横浜市, 大阪市) is never expanded to its wards: those wards are
  purely administrative subdivisions of one city government, not separate
  municipalities -- they don't exist as lookup keys anywhere in this app
  (master.json's 1,747-entry basic-municipality list already excludes them;
  see src/data/municipalities/designated-city-wards.json), and
  resolveGradeArea() is only ever called with municipalityCode values drawn
  from that 1,747-entry list. The source PDF also lists designated cities as
  ordinary single city-name entries, never as an aggregate phrase, so there
  is nothing to expand for them in the first place.
- NAME_ALIASES holds individually-verified katakana variant fixes (PDF
  spelling -> master.json spelling), never a blanket ヶ/ケ normalization.
  Before adding an entry here, confirm character-by-character (see
  data/raw/grade-area/ scratch scripts during development) that it's a pure
  orthographic variant of the same municipality, not a different one.
  Un-mapped mismatches are reported as unmatched, never guessed.

Usage:
    python scripts/grade-area/build.py                    # all prefectures
    python scripts/grade-area/build.py --prefs 東京都        # restrict, for staged rollout
    python scripts/grade-area/build.py --dry-run           # report only, no write
"""
import argparse
import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RAW_DIR = ROOT / "data" / "raw" / "grade-area"
PARSED_ENTRIES_PATH = RAW_DIR / "parsed_entries.json"
MASTER_PATH = ROOT / "src" / "data" / "municipalities" / "master.json"
GRADE_AREA_PATH = ROOT / "src" / "data" / "municipalities" / "grade-area.json"

TARGET_LEVELS = {"1-1", "1-2", "2-1", "2-2"}

NAME_ALIASES = {
    # 鎌ヶ谷市(PDF, U+30F6 small ke) vs 鎌ケ谷市(master.json code 12224,
    # U+30B1 large ke) -- same municipality. Kamagaya City's official
    # gazetted name specifically uses the large ケ, unlike most ヶ place
    # names; this PDF uses the more common small ヶ instead. The only such
    # mismatch found across all 47 prefectures / 329 exception codes.
    ("千葉県", "鎌ヶ谷市"): "鎌ケ谷市",
}


def load_master():
    master = json.loads(MASTER_PATH.read_text(encoding="utf-8"))
    pref_name_to_code = {}
    name_lookup = {}
    wards_by_pref = {}
    for m in master["municipalities"]:
        pref_name_to_code[m["prefecture"]] = m["prefectureCode"]
        name_lookup[(m["prefectureCode"], m["municipality"])] = m["code"]
        if m.get("type") == "特別区":
            wards_by_pref.setdefault(m["prefectureCode"], []).append(m["code"])
    for pc in wards_by_pref:
        wards_by_pref[pc].sort()
    return pref_name_to_code, name_lookup, wards_by_pref


def process(records, pref_name_to_code, name_lookup, wards_by_pref, target_pref_names=None):
    """target_pref_names: iterable of 都道府県 names to restrict to, or None for all."""
    exceptions_by_pref = {}
    unmatched = []
    ward_expansions = []

    for r in records:
        if r["kind"] != "municipality" or r["level"] not in TARGET_LEVELS:
            continue
        pref_name = r["prefecture"]
        if pref_name is None:
            unmatched.append({"reason": "no_prefecture_context", **r})
            continue
        if target_pref_names is not None and pref_name not in target_pref_names:
            continue
        pref_code = pref_name_to_code.get(pref_name)
        if pref_code is None:
            unmatched.append({"reason": "unknown_prefecture", **r})
            continue

        name = NAME_ALIASES.get((pref_name, r["name"]), r["name"])

        if name == "区の存する地域":
            codes = wards_by_pref.get(pref_code, [])
            if not codes:
                unmatched.append({"reason": "no_wards_found_for_expansion", **r})
                continue
            ward_expansions.append({"level": r["level"], "prefecture": pref_name, "expanded_to": codes})
            bucket = exceptions_by_pref.setdefault(pref_code, {})
            for c in codes:
                bucket[c] = r["level"]
            continue

        code = name_lookup.get((pref_code, name))
        if code is None:
            unmatched.append({"reason": "name_not_found_in_master", **r})
            continue
        bucket = exceptions_by_pref.setdefault(pref_code, {})
        bucket[code] = r["level"]

    return exceptions_by_pref, unmatched, ward_expansions


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--prefs", nargs="*", default=None, help="都道府県名で絞り込む(省略時は全都道府県)")
    parser.add_argument("--dry-run", action="store_true", help="grade-area.jsonへの書き込みを行わず結果だけ表示する")
    args = parser.parse_args()

    records = json.loads(PARSED_ENTRIES_PATH.read_text(encoding="utf-8"))
    pref_name_to_code, name_lookup, wards_by_pref = load_master()
    target = set(args.prefs) if args.prefs else None

    exceptions_by_pref, unmatched, ward_expansions = process(
        records, pref_name_to_code, name_lookup, wards_by_pref, target
    )

    print("=== prefectures with exceptions ===")
    for pc, bucket in sorted(exceptions_by_pref.items()):
        levels = Counter(bucket.values())
        print(pc, dict(levels), "total=", len(bucket))

    print("\n=== ward expansions ===")
    for e in ward_expansions:
        print(e)

    print("\n=== unmatched (needs manual review; never guessed) ===")
    for u in unmatched:
        print(u)
    print("unmatched count:", len(unmatched))

    if args.dry_run:
        print("\n--dry-run: grade-area.json not written")
        return

    data = json.loads(GRADE_AREA_PATH.read_text(encoding="utf-8"))
    for pc, bucket in exceptions_by_pref.items():
        data["prefectures"][pc] = {"exceptions": dict(sorted(bucket.items()))}
    data["status"] = "partial_collected" if target else "collected"
    data["source"] = (
        "厚生労働省「お住まいの地域の級地を確認」"
        "(https://www.mhlw.go.jp/content/kyuchi.3010.pdf、"
        "e-Govデータポータル https://data.e-gov.go.jp/data/dataset/mhlw_20140917_1101/"
        "resource/790b4bd1-1089-4417-ab08-acc150e51fe2 経由)。"
        "生活保護法の級地区分告示(1級地-1〜3級地-2の6区分、平成30年10月1日現在)。"
        "3級地(3級地-1・3級地-2)はdefaultGradeのため個別のexceptionsには含めていない。"
    )
    data["retrievedDate"] = "2026-08-11"
    GRADE_AREA_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"\nwritten prefectures: {sorted(exceptions_by_pref.keys())}")


if __name__ == "__main__":
    main()
