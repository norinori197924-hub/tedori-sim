"""extract.pyが生成した抽出結果を検証し、
src/data/rates/2026/national-health-insurance/{municipalityCode}.json として書き出す。

SPEC.md 5章の方針(データ未整備を平均値等で代替しない)を技術的に担保するため:
  - 都道府県公表の一覧表に載っている市町村名でも、municipality_codes.jsonにコード対応が
    無い市町村は書き出さず、スキップ理由をログに残す(この場合はmunicipalityCode自体が
    無いため、index.jsonへの記録もできない)。
  - 所得割率・金額が明らかに異常な値(範囲外)の場合も書き出さず、スキップする。この場合は
    src/data/municipalities/index.jsonにnationalHealthInsuranceStatus: "not_available"の
    エントリを明示的に残し、既存のconfirmedを格下げしない範囲で理由を記録する
    (2026-07-24、東京都の伊豆諸島小規模自治体で標準保険料率の所得割がマイナス値になる
    ケースが見つかったことをきっかけに追加。無言のスキップを避けるための汎用機能)。
  - 既に手動収集済みの高品質データ(dataSourceフィールドを持たない、または
    prefecture_standard_rate/tokyo_special_ward_actual_rate以外の値を持つファイル)は
    上書きしない。代わりに比較用ファイル(data/raw/kokuho/comparisons/)に書き出し、
    差分を確認できるようにする。
  - 賦課限度額(cap)は一覧表に含まれないため、全国標準値を暫定使用し、
    needsReview: true で明示する(自治体により異なる場合があることが判明済み、
    例: 金沢市の医療分は66万円で全国標準67万円と異なる)。一次資料に賦課限度額が
    実際に記載されている場合(prefectures.jsonのソースでhasCapsInSource: trueの場合。
    例: 東京都特別区)は、その値をそのまま使う。

一部の都道府県は一次資料が1系統ではない(例: 東京都は特別区の実際の統一保険料率と、
それ以外の市町村の標準保険料率で資料が分かれる)。この場合はprefectures.jsonのその
エントリが"sources"キー(リスト)を持つ形式になり、ソースごとに個別に処理する
(2026-07-24、東京都対応で追加)。

使い方:
    python scripts/kokuho/build.py            # 全都道府県
    python scripts/kokuho/build.py 07 27 04    # 指定した都道府県コードのみ
"""
import json
import sys
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PREFECTURES_FILE = Path(__file__).resolve().parent / "prefectures.json"
MUNICIPALITY_CODES_FILE = Path(__file__).resolve().parent / "municipality_codes.json"
RAW_DIR = ROOT / "data" / "raw" / "kokuho"
KYOKAI_KENPO_DIR = ROOT / "src" / "data" / "rates" / "2026" / "kyokai-kenpo"
COMPARISON_DIR = RAW_DIR / "comparisons"
NHI_DIR = ROOT / "src" / "data" / "rates" / "2026" / "national-health-insurance"
MUNICIPALITIES_INDEX = ROOT / "src" / "data" / "municipalities" / "index.json"

DEFAULT_CAPS = {"medical": 670000, "support": 260000, "care": 170000, "childSupport": 30000}

RATE_RANGE = (0.0, 0.15)
AMOUNT_RANGE = (0, 100000)
# 資産割は固定資産評価額に対する率であり、所得割(RATE_RANGE)より変動幅が大きい。
# 極小人口自治体では100%を超える値が標準保険料率の計算上出てくることも確認済み
# (2026-07-24、東京都青ヶ島村の介護分で135.90%を実際に観測)。上限は暫定的に広めに
# 設定している。マイナス値(同じく極小人口自治体で標準保険料率の計算上発生しうる)は
# 明確に異常値として弾く。
ASSET_RATE_RANGE = (0.0, 2.0)


def iter_sources(entry: dict):
    """都道府県エントリを (source_id, source辞書) のリストに正規化する。

    "sources"キーが無い従来のフラット形式は、source_id="default"の1件として扱う。
    """
    if "sources" in entry:
        return [(source["id"], {**source, "name": entry["name"]}) for source in entry["sources"]]
    return [("default", entry)]


def extracted_path_for(pref_code: str, source_id: str) -> Path:
    if source_id == "default":
        return RAW_DIR / f"{pref_code}.extracted.json"
    return RAW_DIR / f"{pref_code}_{source_id}.extracted.json"


def comparison_path_for(muni_code: str, source_id: str) -> Path:
    """比較用ファイルのパスを、raw_path_for/extracted_path_forと同じ命名規則
    (単一ソースはsource_id接尾辞なし、複数ソースのみ付与)に揃える。
    2026-07-25、大阪府(単一ソース)で`{muni_code}_default.json`という別名の
    ファイルが作られ、既存の`{muni_code}.json`(古い値のまま)が更新されない
    事故が発生したため追加。"""
    if source_id == "default":
        return COMPARISON_DIR / f"{muni_code}.json"
    return COMPARISON_DIR / f"{muni_code}_{source_id}.json"


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
    # assetRateは2026-07-24に追加したフィールド。既存のextracted.json(assetRateキー
    # 自体が無い)は「資産割の概念が無かった時点のデータ」として0扱いにする後方互換
    # (キーが存在してnullの場合のみ、読み取り不能な異常として弾く)。
    asset_rate = section.get("assetRate", 0)
    if asset_rate is None or not (ASSET_RATE_RANGE[0] <= asset_rate <= ASSET_RATE_RANGE[1]):
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


def build_record(pref_entry: dict, pref_code: str, muni_code: str, muni_name: str, extracted: dict, source: dict) -> dict:
    now = datetime.now(timezone.utc).astimezone().date().isoformat()
    child = extracted["childSupport"]
    has_caps_in_source = bool(source.get("hasCapsInSource"))
    data_source = source.get("dataSource", "prefecture_standard_rate")
    needs_review = source.get("needsReview", True)

    def cap_for(section_name: str, extracted_section: dict):
        if has_caps_in_source and extracted_section.get("cap") is not None:
            return extracted_section["cap"]
        return DEFAULT_CAPS[section_name]

    if data_source == "tokyo_special_ward_actual_rate":
        levy_method = "2方式(所得割+均等割のみ、平等割・資産割なし)"
        review_note = (
            "段階3の自動収集パイプライン(scripts/kokuho/)による生成データ。東京都保健医療局が"
            "公表する『特別区国民健康保険料一覧表』(実際に適用される保険料率の一覧、標準保険料率"
            "とは別の資料)を一次資料とする。特別区は原則として23区共通の保険料率(統一保険料方式)"
            "だが、一部区は独自の値を持つ(2026-07-24調査で確認: 目黒区は介護分の所得割のみ他区と"
            "異なる、中野区・江戸川区は複数区分で独自の値)。このため23区分をそれぞれ個別に一次資料"
            "から読み取っており、1件の値を全区にコピーする処理は行っていない。賦課限度額も一次資料"
            "に実際の記載があるためその値を使用している(全国標準値による代替ではない)。"
        )
    else:
        review_note = (
            "段階3の自動収集パイプライン(scripts/kokuho/)による生成データ。"
            "都道府県公表の「標準保険料率」であり、市町村が実際に条例で定める料率と"
            "異なる場合がある(都道府県資料内に同旨の注記あり)。"
        )
        if not has_caps_in_source:
            review_note += (
                "賦課限度額(cap)は一覧表に含まれないため全国標準値を暫定使用しており、"
                "自治体独自の限度額(例: 金沢市の医療分66万円)とは異なる可能性がある。"
            )
        levy_method = (
            "自動収集のため賦課方式は未確認(平等割額・資産割率が0でない区分があるかで"
            "方式を推定可能だが、今回は判定していない)"
        )

    return {
        "prefecture": pref_entry["name"],
        "municipality": muni_name,
        "municipalityCode": muni_code,
        "municipalityType": None,
        "year": "令和8年度",
        "source": source["sourceUrl"],
        "sourceTitle": source["sourceTitle"],
        "fetchedAt": now,
        "needsReview": needs_review,
        "dataSource": data_source,
        "reviewNote": review_note,
        "levyMethod": levy_method,
        "medical": {**extracted["medical"], "cap": cap_for("medical", extracted["medical"])},
        "support": {**extracted["support"], "cap": cap_for("support", extracted["support"])},
        "care": {**extracted["care"], "cap": cap_for("care", extracted["care"]), "note": "40歳以上65歳未満が対象"},
        "childSupport": {**child, "cap": cap_for("childSupport", child), "note": "令和8年度新設"},
    }


# dataSourceごとの信頼度優先順位。数値が大きいほど信頼度が高い。
# 2026-07-24、東京都対応で発覚した問題への対処: 1つの都道府県が複数ソースを持つ場合
# (東京都の特別区=実際の適用値 と それ以外=標準保険料率という参考値)、同じ市町村
# コードが両方のソースの一覧表に登場しうる(東京都の標準保険料率一覧には23区も
# 掲載されている)。dataSourceの種類を区別せず「prefecture_standard_rate以外なら
# 手動データとみなして保護」という従来の判定だと、tokyo_special_ward_actual_rate
# (信頼度の高い自動データ)がprefecture_standard_rate(信頼度の低い参考値)で
# 上書きされてしまう事故が実際に発生した。dataSourceに含まれない値(手動データ、
# または未知の値)は最優先として扱う。
DATA_SOURCE_PRIORITY = {
    "prefecture_standard_rate": 1,
    "tokyo_special_ward_actual_rate": 2,
}


def should_write(muni_code: str, new_data_source: str) -> bool:
    """既存ファイルと比べて、新しいレコードを本体として書き込んでよいかを判定する。

    既存ファイルが無ければ書き込んでよい。既存ファイルのdataSourceが
    DATA_SOURCE_PRIORITYに無い(手動データ、または未知の値)場合は最優先として
    保護し、書き込まない。両方ともパイプライン産のdataSourceを持つ場合は、
    優先度が同等以上のときのみ書き込みを許可する(同一ソースの再実行による
    更新は許可しつつ、優先度の低いソースが高いソースを上書きすることは防ぐ)。
    """
    path = NHI_DIR / f"{muni_code}.json"
    if not path.exists():
        return True
    existing = json.loads(path.read_text(encoding="utf-8"))
    existing_source = existing.get("dataSource")
    if existing_source not in DATA_SOURCE_PRIORITY:
        return False
    new_priority = DATA_SOURCE_PRIORITY.get(new_data_source, 0)
    return new_priority >= DATA_SOURCE_PRIORITY[existing_source]


@lru_cache(maxsize=1)
def load_kyokai_kenpo_files_by_prefecture() -> dict:
    """kyokai-kenpo/*.jsonを走査し、prefectureCode -> 相対パス(index.json基準)の対応表を作る。

    2026-08-08、新規に市町村をindex.jsonへ追加する際、kyokaiKenpoStatusを無条件で
    "pending"固定していたため、scripts/kyokai-kenpo/build.py(協会けんぽ整備)が既に
    実行済みの都道府県でも、その後kokuhoパイプラインで新規追加された市町村だけが
    pendingのまま取り残される問題が発生した(埼玉・千葉・愛知・兵庫・福岡で発覚)。
    scripts/kyokai-kenpo/build.pyのファイル命名スラッグに依存せず、実際に生成済みの
    ファイルをprefectureCodeで突き合わせることで、どちらのパイプラインを先に実行しても
    整合するようにする。1回のbuild.py実行内で結果をキャッシュする(lru_cache)。
    """
    mapping = {}
    if not KYOKAI_KENPO_DIR.exists():
        return mapping
    for path in sorted(KYOKAI_KENPO_DIR.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        pref_code = data.get("prefectureCode")
        if pref_code:
            mapping[pref_code] = f"rates/2026/kyokai-kenpo/{path.stem}.json"
    return mapping


def update_municipalities_index(pref_entry: dict, pref_code: str, muni_code: str, muni_name: str):
    index = json.loads(MUNICIPALITIES_INDEX.read_text(encoding="utf-8"))
    for m in index["municipalities"]:
        if m["municipalityCode"] == muni_code:
            m["nationalHealthInsuranceStatus"] = "confirmed"
            m["nationalHealthInsuranceFile"] = f"rates/2026/national-health-insurance/{muni_code}.json"
            m["verificationStatus"] = m.get("verificationStatus", "auto_unverified")
            m.pop("nationalHealthInsuranceNotAvailableReason", None)
            break
    else:
        kyokai_kenpo_file = load_kyokai_kenpo_files_by_prefecture().get(pref_code)
        index["municipalities"].append(
            {
                "prefecture": pref_entry["name"],
                "prefectureCode": pref_code,
                "municipality": muni_name,
                "municipalityCode": muni_code,
                "kyokaiKenpoStatus": "confirmed" if kyokai_kenpo_file else "pending",
                "kyokaiKenpoRatesFile": kyokai_kenpo_file,
                "nationalHealthInsuranceStatus": "confirmed",
                "nationalHealthInsuranceFile": f"rates/2026/national-health-insurance/{muni_code}.json",
                "verificationStatus": "auto_unverified",
            }
        )
    MUNICIPALITIES_INDEX.write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def update_municipalities_index_not_available(pref_entry: dict, pref_code: str, muni_code: str, muni_name: str, reason: str):
    """検証エラーで書き出しをスキップした市町村を、index.jsonにnot_availableとして
    明示的に記録する(無言のスキップを避けるための汎用機能。2026-07-24追加)。

    既にnationalHealthInsuranceStatus: "confirmed"のエントリ(手動収集データ、または
    過去の自動収集で成功したデータ)は格下げしない。
    """
    index = json.loads(MUNICIPALITIES_INDEX.read_text(encoding="utf-8"))
    for m in index["municipalities"]:
        if m["municipalityCode"] == muni_code:
            if m.get("nationalHealthInsuranceStatus") == "confirmed":
                return
            m["nationalHealthInsuranceStatus"] = "not_available"
            m["nationalHealthInsuranceFile"] = None
            m["nationalHealthInsuranceNotAvailableReason"] = reason
            m["verificationStatus"] = "not_available"
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
                "nationalHealthInsuranceStatus": "not_available",
                "nationalHealthInsuranceFile": None,
                "nationalHealthInsuranceNotAvailableReason": reason,
                "verificationStatus": "not_available",
            }
        )
    MUNICIPALITIES_INDEX.write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def build_source(pref_code: str, pref_entry: dict, source_id: str, source: dict, pref_codes: dict):
    extracted_path = extracted_path_for(pref_code, source_id)
    label = pref_entry["name"] if source_id == "default" else f"{pref_entry['name']}({source_id})"
    if not extracted_path.exists():
        print(f"[build] skip {label}: 抽出結果が無い(先にextract.pyを実行)")
        return

    extracted = json.loads(extracted_path.read_text(encoding="utf-8"))
    written, skipped, compared = [], [], []

    for muni in extracted.get("municipalities", []):
        name = muni.get("municipalityName", "?")

        if extracted.get("unifiedRate"):
            targets = list(pref_codes.items())
        else:
            if name not in pref_codes:
                skipped.append((name, "municipality_codes.jsonにコード対応が無いためスキップ"))
                continue
            targets = [(name, pref_codes[name])]

        errors = validate_municipality(muni)
        if errors:
            reason = "検証エラー: " + "; ".join(errors)
            skipped.append((name, reason))
            for muni_name, muni_code in targets:
                update_municipalities_index_not_available(pref_entry, pref_code, muni_code, muni_name, reason)
            continue

        for muni_name, muni_code in targets:
            record = build_record(pref_entry, pref_code, muni_code, muni_name, muni, source)
            if not should_write(muni_code, record["dataSource"]):
                COMPARISON_DIR.mkdir(parents=True, exist_ok=True)
                comp_path = comparison_path_for(muni_code, source_id)
                comp_path.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
                compared.append((muni_name, muni_code))
                continue

            NHI_DIR.mkdir(parents=True, exist_ok=True)
            out_path = NHI_DIR / f"{muni_code}.json"
            out_path.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            update_municipalities_index(pref_entry, pref_code, muni_code, muni_name)
            written.append((muni_name, muni_code))

    print(f"[build] {label}: 書き出し{len(written)}件 {written}")
    print(f"[build] {label}: 比較用(手動データと重複、上書きせず){len(compared)}件 {compared}")
    print(f"[build] {label}: スキップ{len(skipped)}件")
    for name, reason in skipped[:20]:
        print(f"         - {name}: {reason}")


def build_prefecture(pref_code: str, pref_entry: dict, codes: dict):
    pref_codes = codes.get(pref_code, {})
    for source_id, source in iter_sources(pref_entry):
        build_source(pref_code, pref_entry, source_id, source, pref_codes)


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
