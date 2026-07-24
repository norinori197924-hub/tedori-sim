"""Prefecture-published municipal standard national health insurance rate
tables (PDF/Excel) downloader.

Some prefectures publish more than one primary source (e.g. Tokyo has a
separate table for the special wards' actual unified rate vs. the standard
rate table for its other municipalities). In that case the prefecture's
entry in prefectures.json has a "sources" list. Single-source prefectures
keep the legacy flat shape (sourceUrl etc. directly on the entry) for
backward compatibility.

Usage:
    python scripts/kokuho/fetch.py            # all prefectures in prefectures.json
    python scripts/kokuho/fetch.py 07 27 04    # only the given prefecture codes
"""
import json
import sys
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
PREFECTURES_FILE = Path(__file__).resolve().parent / "prefectures.json"
RAW_DIR = ROOT / "data" / "raw" / "kokuho"


def iter_sources(entry):
    if "sources" in entry:
        return [(source["id"], source) for source in entry["sources"]]
    return [("default", entry)]


def raw_path_for(pref_code, source_id, ext):
    if source_id == "default":
        return RAW_DIR / (pref_code + ext)
    return RAW_DIR / (pref_code + "_" + source_id + ext)


def fetch_source(pref_code, pref_name, source_id, source):
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    ext = ".pdf" if source["sourceFormat"] == "pdf" else ".xlsx"
    dest = raw_path_for(pref_code, source_id, ext)
    if source_id == "default":
        label = pref_name
    else:
        label = pref_name + "(" + source_id + ")"
    req = Request(source["sourceUrl"], headers={"User-Agent": "tedori-sim-kokuho-pipeline/1.0"})
    with urlopen(req, timeout=60) as res:
        data = res.read()
    dest.write_bytes(data)
    print("[fetch] " + label + ": " + str(len(data)) + " bytes -> " + str(dest))
    return dest


def fetch_prefecture(pref_code, entry):
    for source_id, source in iter_sources(entry):
        fetch_source(pref_code, entry["name"], source_id, source)


def main():
    prefectures = json.loads(PREFECTURES_FILE.read_text(encoding="utf-8"))
    targets = sys.argv[1:] or list(prefectures.keys())
    for pref_code in targets:
        if pref_code not in prefectures:
            print("[fetch] skip: unknown prefecture code " + pref_code)
            continue
        fetch_prefecture(pref_code, prefectures[pref_code])


if __name__ == "__main__":
    main()
