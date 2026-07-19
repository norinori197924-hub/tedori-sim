"""ダウンロード済みの都道府県別PDFから、Claude APIを使って市町村ごとの
国民健康保険標準保険料率を構造化データとして抽出する。

このプロジェクトの一次資料PDFは、都道府県ごとに表のレイアウトが大きく異なり、
決定論的なPDFパーサー(pdfplumber等)を都道府県ごとに個別実装するとメンテナンス
コストが高くなる。Claude APIにPDFを直接渡して読み取らせる方式を採用する
(hojokin-radarのenrich.pyと同様の構成)。

推測で値を埋めないというプロジェクト方針(CLAUDE.md 5章)に従い、プロンプトで
「読み取れない値はnullにする」ことを明示している。

使い方:
    python scripts/kokuho/extract.py            # 全都道府県
    python scripts/kokuho/extract.py 07 27 04    # 指定した都道府県コードのみ
"""
import base64
import json
import os
import sys
from pathlib import Path

from anthropic import Anthropic
from dotenv import load_dotenv

load_dotenv()

ROOT = Path(__file__).resolve().parents[2]
PREFECTURES_FILE = Path(__file__).resolve().parent / "prefectures.json"
RAW_DIR = ROOT / "data" / "raw" / "kokuho"

MODEL = "claude-sonnet-5"

EXTRACTION_PROMPT = """\
これは日本のある都道府県が公表した、市町村ごとの国民健康保険「標準保険料率」の一覧表です。
表から、都道府県内の各市町村について、以下の区分ごとの数値を正確に読み取り、
指定したJSON形式でのみ出力してください(前後に説明文を付けないこと)。

区分: 医療分(medical)、後期高齢者支援金分(support)、介護納付金分(care)、
子ども・子育て支援納付金分(childSupport)

各区分について、所得割率(incomeRate。%表記を小数に変換する。例: 5.07% -> 0.0507)、
均等割額(perCapitaAmount、円)、平等割額(perHouseholdAmount、円。表に列が無ければ0)を
読み取ってください。
子ども・子育て支援納付金分について、18歳未満と18歳以上で均等割額が区別されている場合は
perCapitaAmountUnder18とperCapitaAmountOver18の両方を、区別が無ければ同額を両方に
入れてください。

表が都道府県内で単一の統一料率(全市町村共通)である場合は、municipalitiesに
municipalityNameを"(都道府県内統一)"とした要素を1件だけ返し、最上位の
unifiedRateをtrueにしてください。

出力形式(JSON。この形式以外は出力しないこと):
{
  "unifiedRate": false,
  "municipalities": [
    {
      "municipalityName": "市町村名(都道府県名を含めない表記。例: 福島市)",
      "medical": {"incomeRate": 0.0, "perCapitaAmount": 0, "perHouseholdAmount": 0},
      "support": {"incomeRate": 0.0, "perCapitaAmount": 0, "perHouseholdAmount": 0},
      "care": {"incomeRate": 0.0, "perCapitaAmount": 0, "perHouseholdAmount": 0},
      "childSupport": {"incomeRate": 0.0, "perCapitaAmountUnder18": 0, "perCapitaAmountOver18": 0, "perHouseholdAmount": 0}
    }
  ]
}

表から読み取れない・表に存在しない数値は0ではなくnullにしてください。推測で埋めないでください。

出力に関する厳格なルール:
- 出力は指定したJSON構造そのものだけにしてください。前置き・説明文・補足コメントを
  一切含めないでください。
- マークダウンのコードフェンス(```や```json)を付けないでください。
- JSONの値の直後に補足の説明文字列を書き足さないこと(例: null (理由) のような
  書き方は不正なJSONになるため禁止)。読み取れない場合は理由を書かず、単にnullに
  してください。
- JSON仕様にない記法(コメント、末尾カンマなど)は使わないでください。
"""


def parse_json_response(text: str, debug_path: Path) -> dict:
    """Claude APIの応答テキストをJSONとしてパースする。

    マークダウンのコードフェンスや前後の説明文が付いていても、可能な範囲で
    取り除いてから解析を試みる。それでも解析できない場合は、原因調査のために
    生のレスポンステキストをそのままログに出力し、ファイルにも保存してから例外を
    送出する(推測でごまかさず、GitHub Actionsのログから実際の応答内容を確認
    できるようにするため)。
    """
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("```", 2)[1]
        if cleaned.startswith("json"):
            cleaned = cleaned[4:]
        cleaned = cleaned.strip()

    try:
        return json.loads(cleaned)
    except json.JSONDecodeError as first_error:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start != -1 and end > start:
            try:
                return json.loads(cleaned[start : end + 1])
            except json.JSONDecodeError:
                pass
        debug_path.write_text(text, encoding="utf-8")
        print("[extract] JSON解析失敗。Claude APIの生の応答テキスト(パース前):")
        print("----- raw response start -----")
        print(text)
        print("----- raw response end -----")
        raise ValueError(
            f"Claude APIの応答をJSONとして解析できませんでした({first_error})。"
            f"生の応答テキストは上のログと{debug_path}の両方で確認できます。"
        ) from first_error


def extract_prefecture(pref_code: str, entry: dict) -> dict:
    ext = ".pdf" if entry["sourceFormat"] == "pdf" else ".xlsx"
    raw_path = RAW_DIR / f"{pref_code}{ext}"
    if not raw_path.exists():
        raise FileNotFoundError(f"raw file not found, run fetch.py first: {raw_path}")
    if entry["sourceFormat"] != "pdf":
        raise NotImplementedError("Excel入力からの抽出は今回のパイロット範囲外(PDFのみ対応)")

    client = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])

    data_b64 = base64.standard_b64encode(raw_path.read_bytes()).decode("utf-8")
    content_block = {
        "type": "document",
        "source": {"type": "base64", "media_type": "application/pdf", "data": data_b64},
    }

    message = client.messages.create(
        model=MODEL,
        max_tokens=16384,
        messages=[
            {
                "role": "user",
                "content": [content_block, {"type": "text", "text": EXTRACTION_PROMPT}],
            }
        ],
    )

    text = "".join(block.text for block in message.content if block.type == "text").strip()
    debug_path = RAW_DIR / f"{pref_code}.extracted.raw.txt"
    result = parse_json_response(text, debug_path)

    out_path = RAW_DIR / f"{pref_code}.extracted.json"
    out_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    count = len(result.get("municipalities", []))
    print(f"[extract] {entry['name']}: {count} municipalities -> {out_path}")
    return result


def main():
    prefectures = json.loads(PREFECTURES_FILE.read_text(encoding="utf-8"))
    targets = sys.argv[1:] or list(prefectures.keys())
    for pref_code in targets:
        if pref_code not in prefectures:
            print(f"[extract] skip: unknown prefecture code {pref_code}")
            continue
        extract_prefecture(pref_code, prefectures[pref_code])


if __name__ == "__main__":
    main()
