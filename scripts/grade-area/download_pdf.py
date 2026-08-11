"""Download the MHLW grade-area (級地区分) notice PDF used as the source for
src/data/municipalities/grade-area.json.

The document is published via e-Gov data portal
(https://data.e-gov.go.jp/data/dataset/mhlw_20140917_1101/
resource/790b4bd1-1089-4417-ab08-acc150e51fe2) and hosted directly on
mhlw.go.jp. It lists which municipalities are 1級地/2級地/3級地(-1/-2) under
the Public Assistance Act (生活保護法) grade-area classification, which is
also the basis referenced by CLAUDE.md 11.14 for the resident-tax 均等割
non-taxation threshold's grade coefficient.

Usage:
    python scripts/grade-area/download_pdf.py
"""
import socket
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
RAW_DIR = ROOT / "data" / "raw" / "grade-area"
SOURCE_URL = "https://www.mhlw.go.jp/content/kyuchi.3010.pdf"
DEST = RAW_DIR / "kyuchi.3010.pdf"


def main():
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    socket.setdefaulttimeout(30)
    req = Request(SOURCE_URL, headers={"User-Agent": "Mozilla/5.0"})
    data = urlopen(req).read()
    DEST.write_bytes(data)
    print(f"downloaded {len(data)} bytes -> {DEST}")


if __name__ == "__main__":
    main()
