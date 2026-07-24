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

2026-07-24、東京都(62市区町村)の抽出で、バッチ出力そのものではなくモデルの
思考(thinking)だけでmax_tokensに達し、テキスト出力が0件のまま失敗する事象が
発生した。BATCH_SIZEを縮小し、MAX_TOKENSを引き上げて対処している
(福島県での「応答の途中切れ」とは異なる新しい失敗モード)。

一部の都道府県は一次資料が1系統ではない(例: 東京都は特別区の実際の統一保険料率と、
それ以外の市町村の標準保険料率で資料が分かれる)。この場合はprefectures.jsonの
そのエントリが"sources"キー(リスト)を持つ形式になり、ソースごとに個別に抽出する
(2026-07-24、東京都対応で追加)。また、1枚の表に複数種類の数値(例: 東京都の
「都道府県標準」「区市町村標準(2方式)」「区市町村ごとの算定基準」の3種類)が
並んでいる資料では、prefectures.jsonのソースにextractionNoteを持たせ、どの列を
対象にするかをプロンプトで明示できるようにしている。

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
MAX_TOKENS = 32000
BATCH_SIZE = 10

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

NAME_LIST_PROMPT_TEMPLATE = """\
これは日本のある都道府県が公表した、市町村ごとの国民健康保険「標準保険料率」の一覧表です。
この表に掲載されている市町村名を、表に出てくる順番のまま、過不足なくすべて
JSON配列で返してください(都道府県名は含めない表記。例: 福島市)。データの値そのものは
まだ読み取らなくてよく、名前の一覧だけを返してください。

表が都道府県内で単一の統一料率(全市町村共通)である場合は、municipalityNamesを
["(都道府県内統一)"]の1件だけとし、unifiedRateをtrueにしてください。表に複数の
市町村が個別の行として記載されている場合(値の一部が他の市町村と偶然同じであっても)は、
unifiedRateをtrueにせず、記載されている市町村を1件ずつすべて列挙してください。
{extra_note}
出力形式(JSON。この形式以外は出力しないこと):
{{
  "unifiedRate": false,
  "municipalityNames": ["福島市", "会津若松市", "郡山市"]
}}

{output_rules}"""

FIELD_INSTRUCTIONS = """\
区分: 医療分(medical)、後期高齢者支援金分(support)、介護納付金分(care)、
子ども・子育て支援納付金分(childSupport)

各区分について、所得割率(incomeRate。%表記を小数に変換する。例: 5.07% -> 0.0507)、
均等割額(perCapitaAmount、円)、平等割額(perHouseholdAmount、円)、資産割率
(assetRate。%表記を小数に変換する。例: 35.93% -> 0.3593)を読み取ってください。
子ども・子育て支援納付金分について、18歳未満と18歳以上で均等割額が区別されている場合は
perCapitaAmountUnder18とperCapitaAmountOver18の両方を、区別が無ければ同額を両方に
入れてください。

perHouseholdAmount(平等割額)とassetRate(資産割率)の扱いについて、次の2つのケースを
明確に区別すること:
- その区分の賦課方式にそもそも平等割・資産割が無い(表に該当する列自体が存在しない)
  場合は 0 にしてください。これは「値が無い」ことが表から明確に読み取れる正常な
  ケースであり、推測ではありません。
- 該当する列は表に存在するが、その市町村の行の数値が不鮮明・欠落していて読み取れない
  場合のみ null にしてください。

incomeRateとperCapitaAmountについては、表に値が無い・読み取れない場合は0では
なくnullにしてください(こちらは推測で埋めてはいけないため)。

同じ都道府県内でも、市町村によって平等割・資産割の有無(2〜4方式)が異なる場合が
あります(小規模な自治体ほど資産割を併用する傾向があります)。列の有無は都道府県
全体で一律に決め付けず、市町村ごとの表の実際の記載に従って個別に判断してください。
"""

CAP_FIELD_INSTRUCTIONS = """\
各区分について、賦課限度額(cap、円)もこの表に記載されているため、あわせて
読み取ってください。読み取れない場合はnullにしてください(0にしないこと)。
"""


def name_list_prompt(extra_note: str = "") -> str:
    note_block = f"\n{extra_note}\n" if extra_note else ""
    return NAME_LIST_PROMPT_TEMPLATE.format(extra_note=note_block, output_rules=OUTPUT_RULES)


def batch_extraction_prompt(names: list[str], include_caps: bool = False, extra_note: str = "") -> str:
    names_text = "、".join(names)
    cap_instruction = CAP_FIELD_INSTRUCTIONS if include_caps else ""
    cap_field = ', "cap": 0' if include_caps else ""
    note_block = f"\n{extra_note}\n" if extra_note else ""
    return f"""\
これは日本のある都道府県が公表した、市町村ごとの国民健康保険「標準保険料率」の一覧表です。
表の中から、次に指定する市町村だけについて、以下の区分ごとの数値を正確に読み取り、
指定したJSON形式でのみ出力してください。指定していない市町村の情報は出力しないでください。

対象市町村({len(names)}件): {names_text}
{note_block}
{FIELD_INSTRUCTIONS}
{cap_instruction}
出力形式(JSON。この形式以外は出力しないこと。対象市町村すべてについて1件ずつ、
必ず{len(names)}件のオブジェクトを含めること):
{{
  "municipalities": [
    {{
      "municipalityName": "市町村名(都道府県名を含めない表記。例: 福島市)",
      "medical": {{"incomeRate": 0.0, "perCapitaAmount": 0, "perHouseholdAmount": 0, "assetRate": 0{cap_field}}},
      "support": {{"incomeRate": 0.0, "perCapitaAmount": 0, "perHouseholdAmount": 0, "assetRate": 0{cap_field}}},
      "care": {{"incomeRate": 0.0, "perCapitaAmount": 0, "perHouseholdAmount": 0, "assetRate": 0{cap_field}}},
      "childSupport": {{"incomeRate": 0.0, "perCapitaAmountUnder18": 0, "perCapitaAmountOver18": 0, "perHouseholdAmount": 0, "assetRate": 0{cap_field}}}
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
        # MAX_TOKENSを大きくした際にAnthropic SDKから「10分を超えうる処理は
        # streaming必須」という制約が返ってくることが判明した(2026-07-24、
        # 東京都の抽出で発生)。messages.create()ではなくmessages.stream()を使う。
        with client.messages.stream(
            model=MODEL,
            max_tokens=MAX_TOKENS,
            messages=[
                {
                    "role": "user",
                    "content": [content_block, {"type": "text", "text": prompt}],
                }
            ],
        ) as stream:
            message = stream.get_final_message()
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


def iter_sources(entry: dict):
    """都道府県エントリを (source_id, source辞書) のリストに正規化する。

    "sources"キーが無い従来のフラット形式は、source_id="default"の1件として扱う
    (中間ファイル名は従来どおり{pref_code}.extracted.json等のまま変えない)。
    """
    if "sources" in entry:
        return [(source["id"], {**source, "name": entry["name"]}) for source in entry["sources"]]
    return [("default", entry)]


def raw_path_for(pref_code: str, source_id: str, ext: str) -> Path:
    if source_id == "default":
        return RAW_DIR / f"{pref_code}{ext}"
    return RAW_DIR / f"{pref_code}_{source_id}{ext}"


def extracted_path_for(pref_code: str, source_id: str) -> Path:
    if source_id == "default":
        return RAW_DIR / f"{pref_code}.extracted.json"
    return RAW_DIR / f"{pref_code}_{source_id}.extracted.json"


def extract_source(pref_code: str, source_id: str, source: dict) -> dict:
    ext = ".pdf" if source["sourceFormat"] == "pdf" else ".xlsx"
    raw_path = raw_path_for(pref_code, source_id, ext)
    if not raw_path.exists():
        raise FileNotFoundError(f"raw file not found, run fetch.py first: {raw_path}")
    if source["sourceFormat"] != "pdf":
        raise NotImplementedError("Excel入力からの抽出は今回のパイロット範囲外(PDFのみ対応)")

    label = source["name"] if source_id == "default" else f"{source['name']}({source_id})"
    include_caps = bool(source.get("hasCapsInSource"))
    extra_note = source.get("extractionNote", "")

    client = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    data_b64 = base64.standard_b64encode(raw_path.read_bytes()).decode("utf-8")

    name_list = call_claude(
        client,
        data_b64,
        name_list_prompt(extra_note),
        label=f"{label}(市町村名一覧)",
        debug_path=RAW_DIR / f"{pref_code}_{source_id}.names.raw.txt",
    )
    unified_rate = bool(name_list.get("unifiedRate"))
    names = name_list.get("municipalityNames") or []
    if not names:
        raise ValueError(f"{label}: 市町村名の一覧が空でした(unifiedRate={unified_rate})")
    print(f"[extract] {label}: unifiedRate={unified_rate}, {len(names)}件の市町村名を取得")

    municipalities = []
    for batch_index, batch_names in enumerate(chunk(names, BATCH_SIZE), start=1):
        batch_result = call_claude(
            client,
            data_b64,
            batch_extraction_prompt(batch_names, include_caps=include_caps, extra_note=extra_note),
            label=f"{label}(バッチ{batch_index}: {len(batch_names)}件)",
            debug_path=RAW_DIR / f"{pref_code}_{source_id}.batch{batch_index}.raw.txt",
        )
        batch_municipalities = batch_result.get("municipalities", [])
        print(
            f"[extract] {label} バッチ{batch_index}: "
            f"要求{len(batch_names)}件中{len(batch_municipalities)}件を取得"
        )
        municipalities.extend(batch_municipalities)

    result = {"unifiedRate": unified_rate, "municipalities": municipalities}

    out_path = extracted_path_for(pref_code, source_id)
    out_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[extract] {label}: 合計{len(municipalities)} municipalities -> {out_path}")
    return result


def extract_prefecture(pref_code: str, entry: dict) -> None:
    for source_id, source in iter_sources(entry):
        extract_source(pref_code, source_id, source)


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
