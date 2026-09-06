import json
import openpyxl

wb = openpyxl.load_workbook("data/raw/population/000892952.xlsx", data_only=True)
ws = wb.active

rows = list(ws.iter_rows(min_row=8, values_only=True))
records = []
for row in rows:
    code, pref, muni, male, female, total, households = row[0], row[1], row[2], row[3], row[4], row[5], row[6]
    if code in (None, "-", "団体コード"):
        continue
    if muni == "-":
        continue  # 都道府県合計行はスキップ、市区町村行のみ対象
    if not isinstance(total, (int, float)):
        continue
    records.append({"code": str(code), "prefecture": pref, "municipality": muni, "population": int(total)})

print("total municipality records:", len(records))
print("sample:", records[:3])

# 政令指定都市の区が個別に出るか確認(例: 札幌市中央区 等)
sapporo_wards = [r for r in records if "札幌市" in r["municipality"]]
print("sapporo-related entries:", sapporo_wards[:5])

with open("data/raw/population/municipal_population_r8.json", "w", encoding="utf-8") as f:
    json.dump({
        "source": "総務省「令和8年1月1日住民基本台帳人口・世帯数(市区町村別)(総計)」",
        "sourceUrl": "https://www.soumu.go.jp/main_content/000892952.xlsx",
        "asOf": "令和8年1月1日",
        "records": records,
    }, f, ensure_ascii=False, indent=2)
print("saved to data/raw/population/municipal_population_r8.json")
