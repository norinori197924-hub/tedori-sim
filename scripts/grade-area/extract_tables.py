"""Parse the MHLW grade-area notice PDF (see download_pdf.py) into a flat,
ordered list of (level, prefecture, municipality name) records.

Requires pdfplumber (pip install pdfplumber). Uses pdfplumber's find_tables()/
extract_tables(), which detects the PDF's ruled rectangles (not text-position
heuristics) -- this is far more reliable than reconstructing columns from raw
character x/y coordinates, which was tried first and produced garbled,
mis-split entries whenever a name's justified-text character spacing crossed
a naive column boundary.

Known document quirk (see PAGE_LEVEL_MAP comment below): page 6's table is a
continuation of level 3-1, not a separate 3-2 listing -- confirmed by
comparing each level header's vertical position against its table's bbox
across all 6 pages. Only page 6 has the header positioned *after* its table
body; every other page has the header before its table (normal reading
order). 3級地-2 has zero explicitly-enumerated entries in this document; it
is defined purely as "municipalities not listed above" (the trailing phrase
on page 6). This has no effect on grade-area.json, since levels 3-1/3-2 both
map to the default grade (3) and neither is written to exceptions -- but
mislabeling would corrupt any future feature that needs to distinguish them.

Usage:
    python scripts/grade-area/extract_tables.py
Writes data/raw/grade-area/parsed_entries.json.
"""
import json
import re
from pathlib import Path

import pdfplumber

ROOT = Path(__file__).resolve().parents[2]
RAW_DIR = ROOT / "data" / "raw" / "grade-area"
PDF_PATH = RAW_DIR / "kyuchi.3010.pdf"
OUTPUT_PATH = RAW_DIR / "parsed_entries.json"

PAGE_LEVEL_MAP = {
    (1, 0): "1-1",
    (1, 1): "1-2",
    (2, 0): "2-1",
    (3, 0): "2-2",
    (4, 0): "3-1",
    (5, 0): "3-1",  # continuation of page 4, no new header
    (6, 0): "3-1",  # ALSO a continuation, not a separate 3-2 list -- see module docstring
}

PREF_SUFFIXES = ("都", "道", "府", "県")

# NOTE: "county" (郡) tracking below is informational/best-effort only, not
# used for master.json matching (matching is by (prefectureCode, name) alone,
# since master.json's town/village names don't need county disambiguation --
# see build_grade_area.py's check for name collisions within a prefecture).
# The tracked county can be wrong once a county's own town/village list ends
# and unlabeled entries follow with no explicit header reset (observed for
# Tokyo's outlying islands, which get mis-tagged as 西多摩郡 in the raw
# records even though they administratively have no 郡). Harmless here.


def is_prefecture(name):
    if name == "北海道":
        return True
    return len(name) >= 3 and name.endswith(PREF_SUFFIXES)


def extract():
    records = []
    with pdfplumber.open(PDF_PATH) as pdf:
        for pageno, page in enumerate(pdf.pages, start=1):
            tables = page.find_tables()
            for tidx, table in enumerate(tables):
                level = PAGE_LEVEL_MAP.get((pageno, tidx))
                if level is None:
                    print(f"WARNING: no level mapping for page {pageno} table {tidx}")
                    continue
                data = table.extract()
                if len(data) < 2:
                    continue
                _header_row, body_row = data[0], data[1]
                order = 0
                current_pref = None
                current_county = None
                for cell in body_row:
                    if not cell:
                        continue
                    lines = [re.sub(r"\s+", "", ln) for ln in cell.split("\n") if ln.strip()]
                    for name in lines:
                        order += 1
                        if is_prefecture(name):
                            current_pref = name
                            current_county = None
                            records.append({
                                "level": level, "page": pageno, "order": order,
                                "kind": "prefecture", "prefecture": name,
                                "county": None, "name": name
                            })
                            continue
                        if name.endswith("郡"):
                            current_county = name
                            records.append({
                                "level": level, "page": pageno, "order": order,
                                "kind": "county", "prefecture": current_pref,
                                "county": name, "name": name
                            })
                            continue
                        records.append({
                            "level": level, "page": pageno, "order": order,
                            "kind": "municipality", "prefecture": current_pref,
                            "county": current_county, "name": name
                        })
    return records


def main():
    records = extract()
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(records, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {len(records)} records -> {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
