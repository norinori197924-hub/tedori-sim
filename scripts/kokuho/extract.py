"""ダウンロード済みの都道府県別PDFから、Claude APIを使って市町村ごとの
国民健康保険標準保険料率を構造化データとして抽出する。

このプロジェクトの一次資料PDFは、都道府県ごとに表のレイアウトが大きく異なり、
決定論的なPDFパーサー(pdfplumber等)を都道府県ごとに個別実装するとメンテナンス
コストが高くなる。Claude APIにPDFを直接渡して読み取らせる方式を採用する
(hojokin-radarのenrich.pyと同様の構成)。

推測で値を埋めないというプロジェクト方針(CLAUDE.md 5章)に従い、プロンプトで
「読み取れない値はnullにする」ことを明示している。

市町村数が多い都道府県(例: 福島県59市町村)では、全市町村を1回のAPI呼び出しで
抽出しようとするとmax_tokensの上限に達して応答が途中で切れることが判明した
(2026-07-19)。そのため2段階方式にしている。
  1. まず市町村名の一覧だけを取得する(出力が短いため途中で切れにくい)
  2. 市町村名を少数ずつのバッチに分割し、バッチごとに個別のAPI呼び出しで
     データを抽出する(1回あたりの出力を小さく保つことで、都道府県の
     規模によらず安定させる)

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
MAX_TOKENS = 16384
BATCH_SIZE = 15

OUTPUT_RULES = """\
出力に関する厳格なルール:
- 出力は指定したJSON構造そのものだけにしてください。前置き・説明文・補足コメントを
  一切含めないでください。
- マークダウンのコードフェンス(```や```json)を付けないでください。
- JSONの値の直後に補足の説明文字列を書き足さないこと(例: null (理由) のような
  書き方は不正なJSONになるため禁止)。読み取れない場合は理由を書かず、単にnullに
  してください。
- JSON仕様にない記法(コメント、末尾カンマなど)は使わないでください。
"""

NAME_LIST_PROMPT = f"""\
これは日本のある都道府県が公表した、市町村ごとの国民健康保険「標準保険料率」の一覧表です。
この表に掲載されている市町村名を、表に出てくる順番のまま、過不足なくすべて
JSON配列で返してください(都道府県名は含めない表記。例: 福島市)。データの値そのものは
まだ読み取らなくてよく、名前の一覧だけを返してください。

表が都道府県内で単一の統一料率(全市町村共通)である場合は、municipalityNamesを
["(都道府県内統一)"]の1件だけとし、unifiedRateをtrueにしてください。

出力形式(JSON。この形式以外は出力しないこと):
{{
  "unifiedRate": false,
  "municipalityNames": ["福島市", "会津若松市", "郡山市"]
}}

{OUTPUT_RULES}"""

FIELD_INSTRUCTIONS = """\
区分: 医療分(medical)、後期高齢者支援金分(support)、介護納付金分(care)、
子ども・子育て支援納付金分(childSupport)

各区分について、所得割率(incomeRate。%表記を小数に変換する。例: 5.07% -> 0.0507)、
均等割額(perCapitaAmount、円)、平等割額(perHouseholdAmount、円)を読み取ってください。
子ども・子育て支援納付金分について、18歳未満と18歳以上で均等割額が区別されている場合は
perCapitaAmountUnder18とperCapitaAmountOver18の両方を、区別が無ければ同額を両方に
入れてください。

perHouseholdAmount(平等割額)の扱いについて、次の2つのケースを明確に区別すること:
- その区分の賦課方式にそもそも平等割が無い(2方式運用で、表に平等割の列自体が
  存在しない)場合は 0 にしてください。これは「値が無い」ことが表から明確に
  読み取れる正常なケースであり、推測ではありません。
- 平等割の列は存在するが、その市町村の行の数値が不鮮明・欠落していて読み取れない
  場合のみ null にしてください。

incomeRateとperCapitaAmountについては、表に値が無い・読み取れない場合は0では
なくnullにしてください(こちらは推測で埋めてはいけないため)。

同じ都道府県内であっても、市町村によって平等割の有無(4方式/2方式)が異なる
ことは無いはずなので、perHouseholdAmountを0にするかnullにするかの判断は、
同じ都道府県・同じ区分内では一貫させてください。
"""


def batch_extraction_prompt(names: list[str]) -> str:
    names_text = "、".join(names)
    return f"""\
これは日本のある都道府県が公表した、市町村ごとの国民健康保険「標準保険料率」の一覧表です。
表の中から、次に指定する市町村だけについて、以下の区分ごとの数値を正確に読み取り、
指定したJSON形式でのみ出力してください。指定していない市町村の情報は出力しないでください。

対象市町村({len(names)}件): {names_text}

{FIELD_INSTRUCTIONS}
出力形式(JSON。この形式以外は出力しないこと。対象市町村すべてについて1件ずつ、
必ず{len(names)}件のオブジェクトを含めること):
{{
  "municipalities": [
    {{
      "municipalityName": "市町村名(都道府県名を含めない表記。例: 福島市)",
      "medical": {{"incomeRate": 0.0, "perCapitaAmount": 0, "perHouseholdAmount": 0}},
      "support": {{"incomeRate": 0.0, "perCapitaAmount": 0, "perHouseholdAmount": 0}},
      "care": {{"incomeRate": 0.0, "perCapitaAmount": 0, "perHouseholdAmount": 0}},
      "childSupport": {{"incomeRate": 0.0, "perCapitaAmountUnder18": 0, "perCapitaAmountOver18": 0, "perHouseholdAmount": 0}}
    }}
  ]
}}

{OUTPUT_RULES}"""


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


def call_claude(client: Anthropic, data_b64: str, prompt: str, label: str, debug_path: Path) -> dict:
    """PDF(base64)とプロンプトを渡してClaude APIを呼び出し、JSONとして返す。

    API呼び出し自体の例外・空応答・JSON解析エラーのいずれも、原因特定に必要な
    情報(例外内容、stop_reason、content_block_types、生レスポンス)をログに
    残してから送出する。
    """
    content_block = {
        "type": "document",
        "source": {"type": "base64", "media_type": "application/pdf", "data": data_b64},
    }

    try:
        message = client.messages.create(
            model=MODEL,
            max_tokens=MAX_TOKENS,
            messages=[
                {
                    "role": "user",
                    "content": [content_block, {"type": "text", "text": prompt}],
                }
            ],
        )
    except Exception as api_error:
        print(f"[extract] {label}: Claude API呼び出し自体が例外を送出しました: {api_error!r}")
        raise

    block_types = [block.type for block in message.content]
    print(f"[extract] {label}: stop_reason={message.stop_reason} content_block_types={block_types}")

    text = "".join(block.text for block in message.content if block.type == "text").strip()
    if not text:
        raise ValueError(
            f"{label}: Claude APIのレスポンスにtextブロックが含まれていませんでした"
            f"(stop_reason={message.stop_reason}, content_block_types={block_types})。"
            "APIエラーは発生していない(例外は送出されていない)ため、レート制限や認証エラー"
            "ではなく、応答の中身自体が空だった可能性が高い。"
        )

    return parse_json_response(text, debug_path)


def chunk(items: list, size: int) -> list[list]:
    return [items[i : i + size] for i in range(0, len(items), size)]


def extract_prefecture(pref_code: str, entry: dict) -> dict:
    ext = ".pdf" if entry["sourceFormat"] == "pdf" else ".xlsx"
    raw_path = RAW_DIR / f"{pref_code}{ext}"
    if not raw_path.exists():
        raise FileNotFoundError(f"raw file not found, run fetch.py first: {raw_path}")
    if entry["sourceFormat"] != "pdf":
        raise NotImplementedError("Excel入力からの抽出は今回のパイロット範囲外(PDFのみ対応)")

    client = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    data_b64 = base64.standard_b64encode(raw_path.read_bytes()).decode("utf-8")

    name_list = call_claude(
        client,
        data_b64,
        NAME_LIST_PROMPT,
        label=f"{entry['name']}(市町村名一覧)",
        debug_path=RAW_DIR / f"{pref_code}.names.raw.txt",
    )
    unified_rate = bool(name_list.get("unifiedRate"))
    names = name_list.get("municipalityNames") or []
    if not names:
        raise ValueError(f"{entry['name']}: 市町村名の一覧が空でした(unifiedRate={unified_rate})")
    print(f"[extract] {entry['name']}: unifiedRate={unified_rate}, {len(names)}件の市町村名を取得")

    municipalities = []
    for batch_index, batch_names in enumerate(chunk(names, BATCH_SIZE), start=1):
        batch_result = call_claude(
            client,
            data_b64,
            batch_extraction_prompt(batch_names),
            label=f"{entry['name']}(バッチ{batch_index}: {len(batch_names)}件)",
            debug_path=RAW_DIR / f"{pref_code}.batch{batch_index}.raw.txt",
        )
        batch_municipalities = batch_result.get("municipalities", [])
        print(
            f"[extract] {entry['name']} バッチ{batch_index}: "
            f"要求{len(batch_names)}件中{len(batch_municipalities)}件を取得"
        )
        municipalities.extend(batch_municipalities)

    result = {"unifiedRate": unified_rate, "municipalities": municipalities}

    out_path = RAW_DIR / f"{pref_code}.extracted.json"
    out_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[extract] {entry['name']}: 合計{len(municipalities)} municipalities -> {out_path}")
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
