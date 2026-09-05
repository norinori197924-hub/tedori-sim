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
import copy
import json
import os
import queue
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path

from anthropic import Anthropic
from dotenv import load_dotenv

load_dotenv()

ROOT = Path(__file__).resolve().parents[2]
PREFECTURES_FILE = Path(__file__).resolve().parent / "prefectures.json"
RAW_DIR = ROOT / "data" / "raw" / "kokuho"

MODEL = "claude-sonnet-5"
MAX_TOKENS = 40000
# 2026-08-30、北海道対応で調査: thinkingがMAX_TOKENSを丸ごと使い切り
# textブロックが0件になる非決定的な失敗(紋別市を含むバッチで顕著)への対応として
# output_config.effortをmedium/highに制限する案を試したが、いずれも同じ紋別市を
# PDFの実画像(PyMuPDFでレンダリングし目視照合)と突き合わせたところ、既定
# (effort未指定)では一致した値(perCapitaAmount=30090, perHouseholdAmount=29622)が、
# medium/highでは不一致(29622/28936、29600/29622)になり、精度が明確に劣化した。
# 際限ない思考に迷い込む頻度を下げる代わりに読み取り精度を犠牲にするトレードオフは
# CLAUDE.md 5章(推測で値を埋めない)の方針に反するため不採用とし、effort指定は
# 行わない(=デフォルトのthinking挙動のまま)。信頼性の確保はMAX_CALL_RETRIES・
# CALL_TIMEOUT_SECONDS(下記)・バッチ単位の中間保存の側で行う。
BATCH_SIZE = 10

# 2026-09-05、北海道の紋別市バッチでの異常出力(1件あたり約2,400出力トークン、通常の
# 10倍前後)の原因調査により、thinkingが非決定的にmax_tokensへ迫るまで肥大化する
# ケースが実際にあることが判明した。効果測定用の1バッチ検証がしやすいよう、環境変数
# KOKUHO_MAX_NEW_BATCHESで「新規にAPI呼び出しを行うバッチ数」の上限を設定できるように
# した(未設定の場合は無制限。中間ファイル(inProgress)から再開可能な既存バッチは
# カウントしない)。恒久的な挙動変更ではなく、慎重な段階投入のための一時的な制御弁。
MAX_NEW_BATCHES_PER_RUN = (
    int(os.environ["KOKUHO_MAX_NEW_BATCHES"]) if os.environ.get("KOKUHO_MAX_NEW_BATCHES") else None
)

# 2026-09-05追加: usageログとコスト上限による自動中断。
# 単価はclaude-sonnet-5の公式レート(2026-06-24時点): input $2.00/MTok、
# output $10.00/MTok、prompt cache書き込み(5分TTL、本スクリプトのcache_controlは
# ttl未指定のため既定の5分) $2.50/MTok(=入力の1.25倍)、cache読み込み $0.20/MTok
# (=入力の0.1倍)。extract.pyはcache_controlのttlを指定していないため、
# cache_creation_input_tokensはすべて5分TTL料金として扱ってよい。
PRICE_PER_MTOK_USD = {
    "input": 2.00,
    "cache_write_5m": 2.50,
    "cache_read": 0.20,
    "output": 10.00,
}
MAX_TOTAL_COST_USD = 2.0
USAGE_LOG_PATH = RAW_DIR / "extract_usage.log"

_cumulative_cost_usd = 0.0


class CostLimitExceeded(RuntimeError):
    """累積の概算コストがMAX_TOTAL_COST_USDを超えたため処理を中断する。"""


def log_line(text: str) -> None:
    """標準出力に加えてUSAGE_LOG_PATHにも追記する。

    前回(北海道の異常出力調査)、print()の内容がどこにも保存されておらず、
    実行後にusage(input_tokens/output_tokens等)の実測値を確認できなかった
    反省を踏まえ、コンソール出力とファイルへの永続化を1箇所に集約する。
    """
    print(text)
    timestamp = datetime.now(timezone.utc).isoformat()
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    with USAGE_LOG_PATH.open("a", encoding="utf-8") as f:
        f.write(f"{timestamp} {text}\n")


def estimate_cost_usd(usage) -> float:
    return (
        usage.input_tokens * PRICE_PER_MTOK_USD["input"]
        + usage.cache_creation_input_tokens * PRICE_PER_MTOK_USD["cache_write_5m"]
        + usage.cache_read_input_tokens * PRICE_PER_MTOK_USD["cache_read"]
        + usage.output_tokens * PRICE_PER_MTOK_USD["output"]
    ) / 1_000_000


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
子ども・子育て支援納付金分の均等割について、重要な制度上のルールがあります:
18歳未満の被保険者の均等割は、年齢を問わず(未就学児に限らない。小学生・中学生・
高校生年代も含む)全国一律で全額軽減され、常に0円です(国民健康保険法施行令等に
基づく全国共通の法定制度であり、都道府県・市町村による例外はありません)。
そのため perCapitaAmountUnder18 には、資料にどう書かれていても**常に0**を
入れてください。資料の「均等割」列に金額が記載されていても、その数値を
perCapitaAmountUnder18 に入れてはいけません(その列は実質的に18歳以上専用の
基礎額であり、18歳未満向けの金額ではありません)。

perCapitaAmountOver18(18歳以上の被保険者1人あたりの合計負担額)は、資料の
「均等割」列(=18歳以上専用の基礎額)を読み取ってください。
- 表が「均等割(基礎額)」と「18歳以上均等割(18歳以上のみに追加でかかる加算額)」
  という2つの列に分かれている場合(例: 均等割1,800円・18歳以上均等割73円という
  表記)は、基礎額+加算額の合計(1,800+73=1,873)をperCapitaAmountOver18に
  入れてください。18歳以上均等割の列の数値をそのままperCapitaAmountOver18に
  入れてはいけません(それは加算額であって合計額ではないため)。
- 表に最初から「均等割合計」「18歳以上の合計負担額」のような合計値の列がある
  場合は、その合計値をそのままperCapitaAmountOver18に入れてください。
- 「均等割」列が1つしかない(18歳以上均等割・加算額の列が無い)場合は、その値を
  そのままperCapitaAmountOver18に入れてください。

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


MAX_CALL_RETRIES = 6
CALL_TIMEOUT_SECONDS = 480

# 2026-08-30、北海道(紋別市)対応で発見: thinkingがmax_tokensを使い切り
# textブロックが0件になる失敗(下記except節)は、バッチサイズやMAX_TOKENSの
# 大小に関わらず発生しうる非決定的な現象と判明した。同一の1市(紋別市)を
# 単独で何度も呼び出したところ、MAX_TOKENS=32000/48000では複数回とも
# 確実に失敗した一方、MAX_TOKENS=64000でも成功時の実際の出力はわずか
# 1334トークンで、必要な予算が単純に足りなかったわけではなかった
# (=毎回決まって長い思考に迷い込むわけではなく、確率的に迷い込む回と
# すぐ収束する回がある)。そのため恒久対応は「予算を増やす」ではなく
# 「同じリクエストを複数回まで自動リトライする」とした。ネットワーク切断
# (WinError 10054、同じ調査で複数回観測)も同様に一時的な要因のため、
# API呼び出し自体の例外もリトライ対象に含める。output_config.effortで
# 思考を抑制する対処も試したが、精度が明確に劣化した(下記MODEL付近の
# コメント参照)ため不採用。信頼性はリトライ回数を増やす方向で確保する。
# 実際に177市町村中1バッチ(10件)が3回連続で失敗する事例も観測されたため、
# MAX_CALL_RETRIESは当初の3から6に引き上げた。
#
# さらに同じ北海道の抽出で、SDK/ネットワーク側が例外もstop_reasonも返さず
# 応答自体が数時間単位でハングする事象も発生した(CPU使用率ほぼ0のまま
# プロセスが停止し、標準出力もバッファリングされ何も見えない状態になった)。
# Anthropic SDKのデフォルトタイムアウトはping等のストリームイベントで
# リセットされている可能性があり、当てにできない。そのため、API呼び出しを
# 常駐しないdaemonスレッドで実行し、CALL_TIMEOUT_SECONDS秒でqueue.get()自体
# にタイムアウトをかける方式にした。daemonスレッドはメインスレッド終了時に
# 強制終了されるため、ハングした呼び出しを「見捨てて」次のリトライに進んでも
# プロセスの終了(atexitでの無限待ち)をブロックしない。


def call_claude(client: Anthropic, data_b64: str, prompt: str, label: str, debug_path: Path) -> dict:
    """PDF(base64)とプロンプトを渡してClaude APIを呼び出し、JSONとして返す。

    API呼び出し自体の例外・空応答は、原因が一時的なもの(ネットワーク瞬断、
    thinkingが非決定的にmax_tokensを使い切る現象)である可能性があるため、
    MAX_CALL_RETRIES回まで同一リクエストを再試行する。JSON解析エラーは
    応答自体は得られている(=一時的な要因ではなく、応答内容そのものの問題)
    ためリトライ対象にせず、これまで通り即座に例外を送出する。
    いずれの失敗も、原因特定に必要な情報(例外内容、stop_reason、
    content_block_types、生レスポンス)をログに残す。

    呼び出し前に累積の概算コスト(_cumulative_cost_usd)がMAX_TOTAL_COST_USDを
    超えていないか確認し、超えていれば新規のAPI呼び出しを一切行わずCostLimitExceeded
    を送出する(2026-09-05追加。直前までの完了バッチはextract_source側で既に
    中間保存済みのため、ここで打ち切っても結果は失われない)。
    """
    global _cumulative_cost_usd
    if _cumulative_cost_usd >= MAX_TOTAL_COST_USD:
        raise CostLimitExceeded(
            f"累積概算コストが${_cumulative_cost_usd:.4f}に達し、"
            f"上限${MAX_TOTAL_COST_USD:.2f}を超えたため、{label}の呼び出しを行わずに中断します。"
        )

    # 同一都道府県内で複数バッチ呼び出しを行う際、PDF部分をプロンプトキャッシュの
    # 対象にする(2026-07-25追加)。市町村名一覧取得(1回)+バッチ抽出(数回)は
    # すべて同じPDFをbase64で丸ごと送っており、プレフィックス(PDF文書ブロックが
    # content配列の先頭)が完全に一致するため、2回目以降はキャッシュ読み込み
    # (通常の約0.1倍のコスト)になる想定。
    content_block = {
        "type": "document",
        "source": {"type": "base64", "media_type": "application/pdf", "data": data_b64},
        "cache_control": {"type": "ephemeral"},
    }

    def run_stream(result_queue: "queue.Queue"):
        try:
            # MAX_TOKENSを大きくした際にAnthropic SDKから「10分を超えうる処理は
            # streaming必須」という制約が返ってくることが判明した(2026-07-24、
            # 東京都の抽出で発生)。messages.create()ではなくmessages.stream()を使う。
            with client.messages.stream(
                model=MODEL,
                max_tokens=MAX_TOKENS,
                # 2026-09-05: thinkingを明示的に無効化する。claude-sonnet-5は
                # thinkingが既定でadaptive(モデル任せ)であり、これが北海道の
                # 紋別市バッチ等で非決定的にmax_tokens近くまで肥大化する原因と
                # 特定された(1件あたり出力トークンが通常の10倍前後になる事象)。
                # output_config.effortをmedium/high等に制限する対処は、既存の
                # 調査(本ファイル冒頭コメント参照)で読み取り精度の明確な劣化が
                # 確認済みで不採用としているため、そちらには触れずthinking自体を
                # 無効化する経路を選んだ。
                thinking={"type": "disabled"},
                messages=[
                    {
                        "role": "user",
                        "content": [content_block, {"type": "text", "text": prompt}],
                    }
                ],
            ) as stream:
                message = stream.get_final_message()
            result_queue.put(("ok", message))
        except Exception as api_error:  # noqa: BLE001 - スレッド境界を越えて呼び出し元に伝える
            result_queue.put(("error", api_error))

    last_error: Exception | None = None
    for attempt in range(1, MAX_CALL_RETRIES + 1):
        attempt_label = label if attempt == 1 else f"{label}(リトライ{attempt}/{MAX_CALL_RETRIES})"

        result_queue: "queue.Queue" = queue.Queue()
        thread = threading.Thread(target=run_stream, args=(result_queue,), daemon=True)
        thread.start()
        try:
            status, payload = result_queue.get(timeout=CALL_TIMEOUT_SECONDS)
        except queue.Empty:
            log_line(
                f"[extract] {attempt_label}: {CALL_TIMEOUT_SECONDS}秒以内に応答が完了しませんでした"
                "(ハング/極端に長い思考の疑い)。この呼び出しは見捨ててリトライします。"
            )
            last_error = TimeoutError(f"{attempt_label}: {CALL_TIMEOUT_SECONDS}秒タイムアウト")
            continue

        if status == "error":
            log_line(f"[extract] {attempt_label}: Claude API呼び出し自体が例外を送出しました: {payload!r}")
            last_error = payload
            continue

        message = payload
        block_types = [block.type for block in message.content]
        usage = message.usage
        # 2026-09-05追加: 呼び出しごとの概算コストを算出し、累積コストに加算・
        # ログに残す(usageの実測値がどこにも保存されず原因究明できなかった
        # 反省への対応。累積が上限を超えた場合、次のcall_claude呼び出し冒頭の
        # チェックで中断される)。
        call_cost_usd = estimate_cost_usd(usage)
        _cumulative_cost_usd += call_cost_usd
        log_line(f"[extract] {attempt_label}: stop_reason={message.stop_reason} content_block_types={block_types}")
        log_line(
            f"[extract] {attempt_label}: usage input_tokens={usage.input_tokens} "
            f"cache_creation_input_tokens={usage.cache_creation_input_tokens} "
            f"cache_read_input_tokens={usage.cache_read_input_tokens} "
            f"output_tokens={usage.output_tokens} "
            f"call_cost_usd=${call_cost_usd:.4f} cumulative_cost_usd=${_cumulative_cost_usd:.4f}"
        )

        text = "".join(block.text for block in message.content if block.type == "text").strip()
        if text:
            try:
                return parse_json_response(text, debug_path)
            except ValueError as parse_error:
                # 2026-08-30、北海道対応で発見: stop_reason=max_tokensのまま
                # textブロックが非空(=途中まで出力されている)ケースがある。
                # この場合のJSON解析失敗は応答が途中で切れただけであり、一時的な
                # 要因によるものなのでリトライ対象にする。それ以外(stop_reason
                # =end_turnなのに解析できない等)は応答が完結していながら形式が
                # 不正という genuine な問題のため、従来通り即座に例外を送出する。
                if message.stop_reason != "max_tokens":
                    raise
                log_line(
                    f"[extract] {attempt_label}: stop_reason=max_tokensで応答が途中で切れ、"
                    "JSON解析に失敗しました。リトライします。"
                )
                last_error = parse_error
                continue

        last_error = ValueError(
            f"{attempt_label}: Claude APIのレスポンスにtextブロックが含まれていませんでした"
            f"(stop_reason={message.stop_reason}, content_block_types={block_types})。"
            "APIエラーは発生していない(例外は送出されていない)ため、レート制限や認証エラー"
            "ではなく、応答の中身自体が空だった可能性が高い。"
        )
        log_line(f"[extract] {attempt_label}: {last_error}")

    raise last_error


def chunk(items: list, size: int) -> list[list]:
    return [items[i : i + size] for i in range(0, len(items), size)]


def expand_union_insurers(municipalities: list[dict], union_insurers: dict[str, list[str]]) -> list[dict]:
    """複数市町村が共同で国保を運営する広域連合(例: 北海道の大雪地区広域連合)の
    1レコードを、構成市町村の数だけ複製する。

    都道府県公表の一覧表には、共同運営の実態を反映してこの種の広域連合が単独の
    1行として掲載されることがある(例: 「177 大雪地区広域連合」)。しかし
    municipality_codes.jsonには広域連合自体のコード対応が無く(国保法上は保険者
    でも、tedori-simが扱う基礎自治体マスタの単位ではないため)、素通りさせると
    build.py側の名前マッチングで書き出し先を持たずスキップされてしまう。
    構成市町村は法律上まったく同一の保険料率を適用されるため、同じレート値を
    そのまま複製することは推測による代替(CLAUDE.md 5章が禁じるもの)ではなく、
    実態を正しく反映する処理である。

    union_insurersはprefectures.jsonのその都道府県エントリ(または個別source)が
    持つ、広域連合名 -> 構成市町村名リストのマッピング。ここに登録の無い
    「〜広域連合」名が万一出現しても展開せず素通りさせる(構成市町村を推測で
    当てずっぽうに決めない。build.py側の既存の「コード対応なしスキップ」に委ねる)。
    """
    if not union_insurers:
        return municipalities

    expanded = []
    for muni in municipalities:
        name = muni.get("municipalityName", "")
        member_names = union_insurers.get(name)
        if not member_names:
            expanded.append(muni)
            continue
        print(f"[extract] {name}: 広域連合のため{len(member_names)}市町村へ複製します -> {member_names}")
        for member_name in member_names:
            member = copy.deepcopy(muni)
            member["municipalityName"] = member_name
            expanded.append(member)
    return expanded


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

    out_path = extracted_path_for(pref_code, source_id)

    # 2026-08-30、北海道対応で追加: 環境側の要因(バックグラウンドプロセスの
    # 強制終了等)で177市町村・18バッチの抽出が完走前に中断される事象が実際に
    # 発生した。中断前に完了していたバッチの結果は上のinProgress中間保存で
    # ファイルには残っているため、それを読み込んで「全市町村名が既に揃っている
    # バッチ」はAPI呼び出しをスキップし、そこから再開できるようにする。
    # 市町村名一覧は都道府県公表資料をそのまま列挙するだけの単純な処理のため
    # 実行のたびに順序が変わることはほぼ無いが、念のため位置(バッチ番号)では
    # なく名前の集合の一致で判定する(順序が変わっても正しく再利用できるように)。
    resumed_by_name: dict[str, dict] = {}
    if out_path.exists():
        try:
            existing = json.loads(out_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            existing = {}
        if existing.get("inProgress"):
            for m in existing.get("municipalities", []):
                if m.get("municipalityName"):
                    resumed_by_name[m["municipalityName"]] = m
            print(f"[extract] {label}: 中断済みの中間ファイルを検出、{len(resumed_by_name)}件を再利用します")

    municipalities = []
    new_batches_run = 0
    stopped_early = False
    for batch_index, batch_names in enumerate(chunk(names, BATCH_SIZE), start=1):
        if all(n in resumed_by_name for n in batch_names):
            print(f"[extract] {label} バッチ{batch_index}: 中間ファイルに全件揃っているためAPI呼び出しをスキップ")
            municipalities.extend(resumed_by_name[n] for n in batch_names)
            continue

        # 2026-09-05追加: KOKUHO_MAX_NEW_BATCHES(段階投入・小規模検証用の環境変数)
        # が設定されている場合、新規にAPI呼び出しを行うバッチ数がこの上限に達したら
        # ここで打ち切る。resumed_by_nameで再利用できるバッチはカウントしない
        # (「新規に課金が発生するバッチ数」を制御したいため)。
        if MAX_NEW_BATCHES_PER_RUN is not None and new_batches_run >= MAX_NEW_BATCHES_PER_RUN:
            print(
                f"[extract] {label} バッチ{batch_index}: "
                f"KOKUHO_MAX_NEW_BATCHES={MAX_NEW_BATCHES_PER_RUN}に達したため、"
                "このバッチ以降は呼び出さずに打ち切ります(中間ファイルはinProgressのまま残ります)"
            )
            stopped_early = True
            break

        batch_result = call_claude(
            client,
            data_b64,
            batch_extraction_prompt(batch_names, include_caps=include_caps, extra_note=extra_note),
            label=f"{label}(バッチ{batch_index}: {len(batch_names)}件)",
            debug_path=RAW_DIR / f"{pref_code}_{source_id}.batch{batch_index}.raw.txt",
        )
        new_batches_run += 1
        batch_municipalities = batch_result.get("municipalities", [])
        print(
            f"[extract] {label} バッチ{batch_index}: "
            f"要求{len(batch_names)}件中{len(batch_municipalities)}件を取得"
        )
        municipalities.extend(batch_municipalities)
        # 2026-08-30、北海道対応で追加: 市町村数の多い都道府県は18バッチ超に
        # なることがあり、途中のバッチでハング・クラッシュした場合にそれまで
        # 完了したバッチの結果まで失われる事故が実際に発生した(標準出力の
        # バッファリングと相まって、どこまで進んでいたかの確認すら困難だった)。
        # そのため未展開(広域連合展開前)の中間状態を毎バッチ末尾に上書き保存する。
        # 最終的な正式ファイルは全バッチ完了後・広域連合展開後に別途書き込む
        # (このタイミングでの保存はあくまで途中経過のスナップショット)。
        out_path.write_text(
            json.dumps({"unifiedRate": unified_rate, "municipalities": municipalities, "inProgress": True}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    if stopped_early:
        # KOKUHO_MAX_NEW_BATCHESによる意図的な打ち切り。まだ全バッチ完了して
        # いないため、inProgress:falseの「完了扱い」ファイルには絶対に書き換えない
        # (未完了データを完了扱いにするとbuild.py側で不完全なまま確定してしまう)。
        # 直前のバッチ末尾で書き込み済みのinProgress:trueファイルをそのまま残し、
        # 次回実行時の再開(resumed_by_name)に委ねる。
        print(
            f"[extract] {label}: KOKUHO_MAX_NEW_BATCHESにより打ち切りました"
            f"(このソースの現時点の件数: {len(municipalities)}件、"
            f"うち今回新規に呼び出したバッチ数: {new_batches_run})"
        )
        return {"unifiedRate": unified_rate, "municipalities": municipalities, "inProgress": True}

    union_insurers = source.get("unionInsurers", {})
    if union_insurers:
        before_count = len(municipalities)
        municipalities = expand_union_insurers(municipalities, union_insurers)
        print(f"[extract] {label}: 広域連合展開により{before_count}件 -> {len(municipalities)}件")

    result = {"unifiedRate": unified_rate, "municipalities": municipalities}

    out_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[extract] {label}: 合計{len(municipalities)} municipalities -> {out_path}")
    return result


def extract_prefecture(pref_code: str, entry: dict) -> None:
    for source_id, source in iter_sources(entry):
        extract_source(pref_code, source_id, source)


def main():
    prefectures = json.loads(PREFECTURES_FILE.read_text(encoding="utf-8"))
    targets = sys.argv[1:] or list(prefectures.keys())
    try:
        for pref_code in targets:
            if pref_code not in prefectures:
                print(f"[extract] skip: unknown prefecture code {pref_code}")
                continue
            extract_prefecture(pref_code, prefectures[pref_code])
    except CostLimitExceeded as cost_error:
        # 2026-09-05追加: 累積概算コストが上限に達した場合の安全装置。直前までの
        # バッチはすでにinProgressの中間ファイルとして保存済みなので、ここでは
        # 追加の保存処理をせず、ユーザーへの明示的な通知とログ記録だけを行う。
        log_line(f"[extract] ★コスト上限による中断★: {cost_error}")
        log_line(f"[extract] usageログ: {USAGE_LOG_PATH}")
        sys.exit(1)


if __name__ == "__main__":
    main()
