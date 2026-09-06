import json

# 完了済み都道府県コード(rank1-13のフル展開 + rank14宮城県・rank21福島県のバックフィル)
DONE_PREF_CODES = {"13", "14", "27", "23", "11", "12", "28", "40", "01", "22", "08", "34", "26", "04", "07"}

# 県庁所在地(公知の行政区分情報。総務省等の公式資料で確認可能な事実であり、
# 推測ではない)
PREFECTURAL_CAPITALS = {
    "01": "札幌市", "02": "青森市", "03": "盛岡市", "04": "仙台市", "05": "秋田市",
    "06": "山形市", "07": "福島市", "08": "水戸市", "09": "宇都宮市", "10": "前橋市",
    "11": "さいたま市", "12": "千葉市", "13": "特別区(東京都庁所在地)", "14": "横浜市",
    "15": "新潟市", "16": "富山市", "17": "金沢市", "18": "福井市", "19": "甲府市",
    "20": "長野市", "21": "岐阜市", "22": "静岡市", "23": "名古屋市", "24": "津市",
    "25": "大津市", "26": "京都市", "27": "大阪市", "28": "神戸市", "29": "奈良市",
    "30": "和歌山市", "31": "鳥取市", "32": "松江市", "33": "岡山市", "34": "広島市",
    "35": "山口市", "36": "徳島市", "37": "高松市", "38": "松山市", "39": "高知市",
    "40": "福岡市", "41": "佐賀市", "42": "長崎市", "43": "熊本市", "44": "大分市",
    "45": "宮崎市", "46": "鹿児島市", "47": "那覇市",
}

# 政令指定都市(20市、公知の行政区分情報)とその所在都道府県コード
DESIGNATED_CITIES = {
    "01": ["札幌市"], "04": ["仙台市"], "11": ["さいたま市"], "12": ["千葉市"],
    "14": ["横浜市", "川崎市", "相模原市"], "15": ["新潟市"], "22": ["静岡市", "浜松市"],
    "23": ["名古屋市"], "26": ["京都市"], "27": ["大阪市", "堺市"], "28": ["神戸市"],
    "33": ["岡山市"], "34": ["広島市"], "40": ["北九州市", "福岡市"], "43": ["熊本市"],
}

MIN_COUNT = 3
MAX_COUNT = 8
COVERAGE_TARGET_LOW = 0.50
COVERAGE_TARGET_HIGH = 0.60

master = json.loads(open("src/data/municipalities/master.json", encoding="utf-8").read())
pop_data = json.loads(open("data/raw/population/municipal_population_r8.json", encoding="utf-8").read())
rollout = json.loads(open("scripts/kokuho/prefecture_rollout_order.json", encoding="utf-8").read())

# master.jsonの正式な1,747市区町村リスト(政令市の区を除く)に、
# 人口データを名前マッチングで紐付ける。
# 総務省の市区町村別人口データは、町村について「郡名+町村名」の形式
# (例: 東津軽郡平内町)で記載され、その直前に「郡名」だけの郡合計行
# (例: 東津軽郡)がある。単純に最初の「郡」で分割すると、「郡上市」
# 「大和郡山市」のように市名自体に「郡」を含む市を誤って分割してしまう
# ため、行の出現順を使い「直前に出てきた郡合計行のプレフィックスと
# 完全一致する場合のみ」そのプレフィックスを取り除く状態管理方式にする。
# 異体字による表記ゆれ(総務省データの旧字体 -> master.jsonの表記)。
# 級地区分マスタ投入時の「鎌ヶ谷市」(CLAUDE.md 11.14章)と同種の事例。
KANJI_VARIANT_ALIASES = {
    "檮原町": "梼原町",
}

pop_by_pref_muni = {}
current_county_prefix = None
current_pref = None
for r in pop_data["records"]:
    pref, muni = r["prefecture"], r["municipality"]
    if pref != current_pref:
        current_pref = pref
        current_county_prefix = None
    if muni.endswith("郡"):
        current_county_prefix = muni
        continue  # 郡合計行(実在の市区町村ではない)
    if current_county_prefix and muni.startswith(current_county_prefix):
        muni = muni[len(current_county_prefix):]
        muni = KANJI_VARIANT_ALIASES.get(muni, muni)
    else:
        current_county_prefix = None  # 郡グループの範囲外(市など)に戻った
    pop_by_pref_muni[(pref, muni)] = r["population"]

pref_names = {e["prefectureCode"]: e["prefecture"] for e in rollout["order"]}

plan = {}
unmatched_total = []
for pref_code, pref_name in sorted(pref_names.items()):
    if pref_code in DONE_PREF_CODES:
        continue
    munis = [m for m in master["municipalities"] if m["prefectureCode"] == pref_code]
    entries = []
    for m in munis:
        pop = pop_by_pref_muni.get((pref_name, m["municipality"]))
        if pop is None:
            unmatched_total.append((pref_name, m["municipality"]))
            continue
        entries.append({"name": m["municipality"], "code": m["code"], "population": pop})

    total_pop = sum(e["population"] for e in entries)
    entries_by_pop = sorted(entries, key=lambda e: -e["population"])

    capital = PREFECTURAL_CAPITALS[pref_code]
    designated = DESIGNATED_CITIES.get(pref_code, [])
    must_include_names = {capital, *designated}

    selected = []
    selected_names = set()
    # 1. 県庁所在地・政令指定都市を必須採用
    for e in entries_by_pop:
        if e["name"] in must_include_names and e["name"] not in selected_names:
            selected.append(e)
            selected_names.add(e["name"])

    # 2. 残りを人口順に追加し、カバー率が50~60%に達するまで(下限3・上限8)
    cumulative = sum(e["population"] for e in selected)
    for e in entries_by_pop:
        if e["name"] in selected_names:
            continue
        coverage = cumulative / total_pop if total_pop else 0
        if len(selected) >= MAX_COUNT:
            break
        if len(selected) >= MIN_COUNT and coverage >= COVERAGE_TARGET_LOW:
            break
        selected.append(e)
        selected_names.add(e["name"])
        cumulative += e["population"]

    final_coverage = cumulative / total_pop if total_pop else 0
    plan[pref_code] = {
        "prefecture": pref_name,
        "totalPopulation": total_pop,
        "selected": selected,
        "coverage": round(final_coverage, 4),
        "count": len(selected),
    }

print(f"未マッチの市町村(人口データに対応が見つからなかった件数): {len(unmatched_total)}")
for x in unmatched_total[:20]:
    print("  ", x)

with open("data/raw/population/wide_coverage_plan_draft.json", "w", encoding="utf-8") as f:
    json.dump(plan, f, ensure_ascii=False, indent=2)

print()
print(f"対象都道府県数: {len(plan)}")
for pref_code, p in plan.items():
    names = [e["name"] for e in p["selected"]]
    print(f"{pref_code} {p['prefecture']}: {p['count']}件, カバー率{p['coverage']*100:.1f}% -> {names}")
