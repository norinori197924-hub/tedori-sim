"""extract.pyが生成した抽出結果を検証し、
src/data/rates/2026/national-health-insurance/{municipalityCode}.json として書き出す。

SPEC.md 5章の方針(データ未整備を平均値等で代替しない)を技術的に担保するため:
  - 都道府県公表の一覧表に載っている市町村名でも、municipality_codes.jsonに
    コード対応が無い市町村は書き出さず、スキップ理由をログに残す。
  - 所得割率・金額が明らかに異常な値(範囲外)の場合も書き出さず、スキップする。
  - 既に手動収集済みの高品質データ(dataSourceフィールドを持たない、または
    prefecture_standard_rate以外の値を持つファイル)は上書きしない。代わりに
    比較用ファイル(data/raw/kokuho/comparisons/)に書き出し、差分を確認できるようにする。
  - 賦課限度額(cap)は一覧表に含まれないため、全国標準値を暫定使用し、
    needsReview: true で明示する(自治体により異なる場合があることが判明済み、
    例: 金沢市の医療分は66万円で全国標準67万円と異なる)。

使い方:
    python scripts/kokuho/build.py            # 全都道府県
    python scripts/kokuho/build.py 07 27 04    # 指定した都道府県コードのみ
"""
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PREFECTURES_FILE = Path(__file__).resolve().parent / "prefectures.json"
MUNICIPALITY_CODES_FILE = Path(__file__).resolve().parent / "municipality_codes.json"
RAW_DIR = ROOT / "data" / "raw" / "kokuho"
COMPARISON_DIR = RAW_DIR / "comparisons"
NHI_DIR = ROOT / "src" / "data" / "rates" / "2026" / "national-health-insurance"
MUNICIPALITIES_INDEX = ROOT / "src" / "data" / "municipalities" / "index.json"

DEFAULT_CAPS = {"medical": 670000, "support": 260000, "care": 170000, "childSupport": 30000}

RATE_RANGE = (0.0, 0.15)
AMOUNT_RANGE = (0, 100000)


def is_valid_section(section: dict, under_over: bool = False) -> bool:
    if section is None:
        return False
    rate = section.get("incomeRate")
    if rate is None or not (RATE_RANGE[0] <= rate <= RATE_RANGE[1]):
        return False
    keys = ["perCapitaAmountUnder18", "perCapitaAmountOver18"] if under_over else ["perCapitaAmount"]
    for key in keys:
        amount = section.get(key)
        if amount is None or not (AMOUNT_RANGE[0] <= amount <= AMOUNT_RANGE[1]):
            return False
    household = section.get("perHouseholdAmount")
    if household is None or not (AMOUNT_RANGE[0] <= household <= AMOUNT_RANGE[1]):
        return False
    return True


def validate_municipality(entry: dict) -> list[str]:
    """検証エラーのリストを返す(空なら妥当)。"""
    errors = []
    for section_name, under_over in [("medical", False), ("support", False), ("care", False), ("childSupport", True)]:
        section = entry.get(section_name)
        if not is_valid_section(section, under_over):
            errors.append(f"{section_name}の値が不正または欠落しています: {section}")
    return errors


def build_record(pref_entry: dict, pref_code: str, muni_code: str, muni_name: str, extracted: dict) -> dict:
    now = datetime.now(timezone.utc).astimezone().date().isoformat()
    child = extracted["childSupport"]

    def cap_for(name):
        return DEFAULT_CAPS[name]

    return {
        "prefecture": pref_entry["name"],
        "municipality": muni_name,
        "municipalityCode": muni_code,
        "municipalityType": None,
        "year": "令和8年度",
        "source": pref_entry["sourceUrl"],
        "sourceTitle": pref_entry["sourceTitle"],
        "fetchedAt": now,
        "needsReview": True,
        "dataSource": "prefecture_standard_rate",
        "reviewNote": (
            "段階3の自動収集パイプライン(scripts/kokuho/)による生成データ。"
            "都道府県公表の「標準保険料率」であり、市町村が実際に条例で定める料率と"
            "異なる場合がある(都道府県資料内に同旨の注記あり)。"
            "賦課限度額(cap)は一覧表に含まれないため全国標準値を暫定使用しており、"
            "自治体独自の限度額(例: 金沢市の医療分66万円)とは異なる可能性がある。"
        ),
        "levyMethod": "自動収集のため賦課方式は未確認(平等割額が0でない区分があるかで4方式/2方式を推定可能だが、今回は判定していない)",
        "medical": {**extracted["medical"], "cap": cap_for("medical")},
        "support": {**extracted["support"], "cap": cap_for("support")},
        "care": {**extracted["care"], "cap": cap_for("care"), "note": "40歳以上65歳未満が対象"},
        "childSupport": {**child, "cap": cap_for("childSupport"), "note": "令和8年度新設"},
    }


def has_manual_data(muni_code: str) -> bool:
    path = NHI_DIR / f"{muni_code}.json"
    if not path.exists():
        return False
    existing = json.loads(path.read_text(encoding="utf-8"))
    return existing.get("dataSource") != "prefecture_standard_rate"


def update_municipalities_index(pref_entry: dict, pref_code: str, muni_code: str, muni_name: str):
    index = json.loads(MUNICIPALITIES_INDEX.read_text(encoding="utf-8"))
    for m in index["municipalities"]:
        if m["municipalityCode"] == muni_code:
            m["nationalHealthInsuranceStatus"] = "confirmed"
            m["nationalHealthInsuranceFile"] = f"rates/2026/national-health-insurance/{muni_code}.json"
            break
    else:
        index["municipalities"].append(
            {
                "prefecture": pref_entry["name"],
                "prefectureCode": pref_code,
                "municipality": muni_name,
                "municipalityCode": muni_code,
                "kyokaiKenpoStatus": "pending",
                "kyokaiKenpoRatesFile": None,
                "nationalHealthInsuranceStatus": "confirmed",
                "nationalHealthInsuranceFile": f"rates/2026/national-health-insurance/{muni_code}.json",
            }
        )
    MUNICIPALITIES_INDEX.write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def build_prefecture(pref_code: str, pref_entry: dict, codes: dict):
    extracted_path = RAW_DIR / f"{pref_code}.extracted.json"
    if not extracted_path.exists():
        print(f"[build] skip {pref_entry['name']}: 抽出結果が無い(先にextract.pyを実行)")
        return

    extracted = json.loads(extracted_path.read_text(encoding="utf-8"))
    pref_codes = codes.get(pref_code, {})
    written, skipped, compared = [], [], []

    for muni in extracted.get("municipalities", []):
        errors = validate_municipality(muni)
        if errors:
            skipped.append((muni.get("municipalityName", "?"), "検証エラー: " + "; ".join(errors)))
            continue

        if extracted.get("unifiedRate"):
            targets = list(pref_codes.items())
        else:
            name = muni["municipalityName"]
            if name not in pref_codes:
                skipped.append((name, "municipality_codes.jsonにコード対応が無いためスキップ"))
                continue
            targets = [(name, pref_codes[name])]

        for muni_name, muni_code in targets:
            record = build_record(pref_entry, pref_code, muni_code, muni_name, muni)
            if has_manual_data(muni_code):
                COMPARISON_DIR.mkdir(parents=True, exist_ok=True)
                comp_path = COMPARISON_DIR / f"{muni_code}.json"
                comp_path.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
                compared.append((muni_name, muni_code))
                continue

            NHI_DIR.mkdir(parents=True, exist_ok=True)
            out_path = NHI_DIR / f"{muni_code}.json"
            out_path.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            update_municipalities_index(pref_entry, pref_code, muni_code, muni_name)
            written.append((muni_name, muni_code))

    print(f"[build] {pref_entry['name']}: 書き出し{len(written)}件 {written}")
    print(f"[build] {pref_entry['name']}: 比較用(手動データと重複、上書きせず){len(compared)}件 {compared}")
    print(f"[build] {pref_entry['name']}: スキップ{len(skipped)}件")
    for name, reason in skipped[:20]:
        print(f"         - {name}: {reason}")


def main():
    prefectures = json.loads(PREFECTURES_FILE.read_text(encoding="utf-8"))
    codes = json.loads(MUNICIPALITY_CODES_FILE.read_text(encoding="utf-8"))
    targets = sys.argv[1:] or list(prefectures.keys())
    for pref_code in targets:
        if pref_code not in prefectures:
            print(f"[build] skip: unknown prefecture code {pref_code}")
            continue
        build_prefecture(pref_code, prefectures[pref_code], codes)


if __name__ == "__main__":
    main()
