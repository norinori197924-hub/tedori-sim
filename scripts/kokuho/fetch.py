"""都道府県が公表する市町村標準保険料率一覧(PDF/Excel)をダウンロードする。

使い方:
    python scripts/kokuho/fetch.py            # prefectures.json内の全都道府県
    python scripts/kokuho/fetch.py 07 27 04    # 指定した都道府県コードのみ
"""
import json
import sys
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
PREFECTURES_FILE = Path(__file__).resolve().parent / "prefectures.json"
RAW_DIR = ROOT / "data" / "raw" / "kokuho"


def fetch_prefecture(pref_code: str, entry: dict) -> Path:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    ext = ".pdf" if entry["sourceFormat"] == "pdf" else ".xlsx"
    dest = RAW_DIR / f"{pref_code}{ext}"
    req = Request(entry["sourceUrl"], headers={"User-Agent": "tedori-sim-kokuho-pipeline/1.0"})
    with urlopen(req, timeout=60) as res:
        data = res.read()
    dest.write_bytes(data)
    print(f"[fetch] {entry['name']}: {len(data)} bytes -> {dest}")
    return dest


def main():
    prefectures = json.loads(PREFECTURES_FILE.read_text(encoding="utf-8"))
    targets = sys.argv[1:] or list(prefectures.keys())
    for pref_code in targets:
        if pref_code not in prefectures:
            print(f"[fetch] skip: unknown prefecture code {pref_code}")
            continue
        fetch_prefecture(pref_code, prefectures[pref_code])


if __name__ == "__main__":
    main()
