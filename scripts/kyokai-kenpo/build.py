"""協会けんぽ都道府県別の健康保険料率(令和8年度)から、47都道府県分の
src/data/rates/2026/kyokai-kenpo/{prefecture}.json を生成する。

背景:
  既存の3件(北海道・東京都・千葉県、2026-07-18に手動収集)を分析した結果、
  都道府県で異なるのは「一般保険料率(healthInsuranceRate)」1つだけであると判明した。
  50等級の標準報酬月額区分(minRemuneration/maxRemuneration/standardMonthlyRemuneration/
  pensionGrade)は健康保険法で全国共通に定められており、介護保険料率(1.62%)・
  子ども子育て支援金率(0.23%)も協会けんぽ全体で一律である。そのため、47都道府県分の
  保険料額表は「一般保険料率」さえ都道府県ごとに分かれば機械的に算出できる。

一次資料:
  https://www.kyoukaikenpo.or.jp/about/business/insurance_rate/rate_prefectures/r08/index.html
  (協会けんぽ公式サイト「令和8年度の協会けんぽの保険料率」都道府県毎の一般保険料率一覧、
  2026-07-26取得)。既存3件の値(北海道10.28%・東京都9.85%・千葉県9.73%)と完全一致し、
  ソースの正しさを確認済み。

計算式(既存ファイルの数値から逆算し、全グレードで一致することを確認済み):
  healthPremiumTotal          = standardMonthlyRemuneration * healthInsuranceRate
  healthPremiumWithCareTotal  = standardMonthlyRemuneration * (healthInsuranceRate + CARE_RATE)
  childcareSupportTotal       = standardMonthlyRemuneration * CHILDCARE_RATE
  各Half = Total / 2

使い方:
    python scripts/kyokai-kenpo/build.py
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
KYOKAI_DIR = ROOT / "src" / "data" / "rates" / "2026" / "kyokai-kenpo"
MUNICIPALITIES_INDEX = ROOT / "src" / "data" / "municipalities" / "index.json"
TEMPLATE_FILE = KYOKAI_DIR / "tokyo.json"

SOURCE_URL = "https://www.kyoukaikenpo.or.jp/about/business/insurance_rate/rate_prefectures/r08/index.html"
SOURCE_TITLE = "全国健康保険協会 令和8年度の協会けんぽの保険料率(都道府県毎の一般保険料率一覧)"
FETCHED_AT = "2026-07-26"
YEAR_LABEL = "令和8年度(令和8年3月分/4月納付分〜)"

CARE_RATE = 0.0162
CHILDCARE_RATE = 0.0023

# (prefectureCode, prefecture, ファイル名スラッグ, 一般保険料率)
# 出典: SOURCE_URL (2026-07-26取得)。北海道・東京都・千葉県は既存手動収集ファイルと完全一致を確認済み。
PREFECTURE_RATES = [
    ("01", "北海道", "hokkaido", 0.1028),
    ("02", "青森県", "aomori", 0.0985),
    ("03", "岩手県", "iwate", 0.0951),
    ("04", "宮城県", "miyagi", 0.1010),
    ("05", "秋田県", "akita", 0.1001),
    ("06", "山形県", "yamagata", 0.0975),
    ("07", "福島県", "fukushima", 0.0950),
    ("08", "茨城県", "ibaraki", 0.0952),
    ("09", "栃木県", "tochigi", 0.0982),
    ("10", "群馬県", "gunma", 0.0968),
    ("11", "埼玉県", "saitama", 0.0967),
    ("12", "千葉県", "chiba", 0.0973),
    ("13", "東京都", "tokyo", 0.0985),
    ("14", "神奈川県", "kanagawa", 0.0992),
    ("15", "新潟県", "niigata", 0.0921),
    ("16", "富山県", "toyama", 0.0959),
    ("17", "石川県", "ishikawa", 0.0970),
    ("18", "福井県", "fukui", 0.0971),
    ("19", "山梨県", "yamanashi", 0.0955),
    ("20", "長野県", "nagano", 0.0963),
    ("21", "岐阜県", "gifu", 0.0980),
    ("22", "静岡県", "shizuoka", 0.0961),
    ("23", "愛知県", "aichi", 0.0993),
    ("24", "三重県", "mie", 0.0977),
    ("25", "滋賀県", "shiga", 0.0988),
    ("26", "京都府", "kyoto", 0.0989),
    ("27", "大阪府", "osaka", 0.1013),
    ("28", "兵庫県", "hyogo", 0.1012),
    ("29", "奈良県", "nara", 0.0991),
    ("30", "和歌山県", "wakayama", 0.1006),
    ("31", "鳥取県", "tottori", 0.0986),
    ("32", "島根県", "shimane", 0.0994),
    ("33", "岡山県", "okayama", 0.1005),
    ("34", "広島県", "hiroshima", 0.0978),
    ("35", "山口県", "yamaguchi", 0.1015),
    ("36", "徳島県", "tokushima", 0.1024),
    ("37", "香川県", "kagawa", 0.1002),
    ("38", "愛媛県", "ehime", 0.0998),
    ("39", "高知県", "kochi", 0.1005),
    ("40", "福岡県", "fukuoka", 0.1011),
    ("41", "佐賀県", "saga", 0.1055),
    ("42", "長崎県", "nagasaki", 0.1006),
    ("43", "熊本県", "kumamoto", 0.1008),
    ("44", "大分県", "oita", 0.1008),
    ("45", "宮崎県", "miyazaki", 0.0977),
    ("46", "鹿児島県", "kagoshima", 0.1013),
    ("47", "沖縄県", "okinawa", 0.0944),
]


def round1(x):
    return round(x + 1e-9, 1)


def build_grades(template_grades, rate):
    grades = []
    for g in template_grades:
        smr = g["standardMonthlyRemuneration"]
        health_total = round1(smr * rate)
        health_with_care_total = round1(smr * (rate + CARE_RATE))
        childcare_total = round1(smr * CHILDCARE_RATE)
        entry = {
            "grade": g["grade"],
        }
        if "pensionGrade" in g:
            entry["pensionGrade"] = g["pensionGrade"]
        entry.update({
            "minRemuneration": g["minRemuneration"],
            "maxRemuneration": g["maxRemuneration"],
            "standardMonthlyRemuneration": smr,
            "healthPremiumTotal": health_total,
            "healthPremiumHalf": round1(health_total / 2),
            "healthPremiumWithCareTotal": health_with_care_total,
            "healthPremiumWithCareHalf": round1(health_with_care_total / 2),
            "childcareSupportTotal": childcare_total,
            "childcareSupportHalf": round1(childcare_total / 2),
        })
        grades.append(entry)
    return grades


def main():
    template = json.loads(TEMPLATE_FILE.read_text(encoding="utf-8"))
    template_grades = template["grades"]

    for code, prefecture, slug, rate in PREFECTURE_RATES:
        rate_with_care = round(rate + CARE_RATE, 4)
        data = {
            "prefecture": prefecture,
            "prefectureCode": code,
            "year": YEAR_LABEL,
            "description": (
                "協会けんぽ " + prefecture + "支部の健康保険・介護保険料率および標準報酬月額等級表"
                "(第1〜50等級)。厚生年金保険料は employees-pension.json を参照"
                "(号級は共有するが、健康保険等級4が厚生年金等級1に対応、以降+3のオフセット。"
                "健康保険等級36以降は厚生年金の対象外)。"
                "50等級の区分・金額は健康保険法上全国共通のため、一般保険料率(healthInsuranceRate)"
                "から機械的に算出している(scripts/kyokai-kenpo/build.py参照)。"
            ),
            "source": SOURCE_URL,
            "sourceTitle": SOURCE_TITLE,
            "fetchedAt": FETCHED_AT,
            "needsReview": False,
            "healthInsuranceRate": rate,
            "careInsuranceRate": CARE_RATE,
            "healthInsuranceRateWithCare": rate_with_care,
            "careInsuranceApplicableAge": {
                "min": 40, "max": 64, "note": "介護保険第2号被保険者。40〜64歳に適用。"
            },
            "childcareSupportContribution": {
                "note": (
                    "子ども・子育て支援金率。令和8年4月分(5月納付分)から新設。"
                    "被保険者・事業主で折半。厚生年金保険料や従来の子ども・子育て拠出金"
                    "(事業主のみ負担0.36%)とは別の新制度。社会保険料内訳では健康保険料・"
                    "介護保険料とは別行の独立項目として表示する(ユーザー承認済み)。"
                ),
                "rate": CHILDCARE_RATE,
                "appliedFrom": "令和8年4月分(5月納付分)",
                "displayAsSeparateLineItem": True,
                "uiBadge": "新設(令和8年4月分〜)",
                "needsReview": False,
            },
            "roundingRule": "被保険者負担分の円未満端数は給与天引きなら50銭以下切り捨て・超で切り上げ。",
            "grades": build_grades(template_grades, rate),
        }
        out_path = KYOKAI_DIR / f"{slug}.json"
        out_path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        print(f"wrote {out_path.relative_to(ROOT)}")

    update_municipalities_index()


def update_municipalities_index():
    rate_by_code = {code: slug for code, _, slug, _ in PREFECTURE_RATES}
    idx = json.loads(MUNICIPALITIES_INDEX.read_text(encoding="utf-8"))
    updated = 0
    for m in idx["municipalities"]:
        slug = rate_by_code.get(m["prefectureCode"])
        if slug is None:
            continue
        if m.get("kyokaiKenpoStatus") != "confirmed":
            updated += 1
        m["kyokaiKenpoStatus"] = "confirmed"
        m["kyokaiKenpoRatesFile"] = f"rates/2026/kyokai-kenpo/{slug}.json"
    MUNICIPALITIES_INDEX.write_text(
        json.dumps(idx, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"updated {updated} municipalities to kyokaiKenpoStatus=confirmed")


if __name__ == "__main__":
    main()
