#!/usr/bin/env bash
# durable 版 SAGA を 1 実行起動し、終了まで待って結果と履歴サマリを表示する。
# 使い方: scripts/run-durable.sh <eventId> '<payload json>'
set -euo pipefail
export AWS_PAGER=""
REGION="${AWS_REGION:-ap-northeast-1}"
# AWS_PROFILE が設定されているときだけ --profile を付ける（環境変数の認証情報でも動くように）
PROFILE_OPT="${AWS_PROFILE:+--profile $AWS_PROFILE}"
# 関数名と版はデプロイ後の CfnOutput / publish-version から渡す（例: export DURABLE_FN=... DURABLE_VER=1）
DF="${DURABLE_FN:?set DURABLE_FN to the deployed durable function name}"
VER="${DURABLE_VER:?run publish-version and export DURABLE_VER}"

EVENT_ID="${1:?usage: $0 <eventId> '<payload json>'}"
PAYLOAD="${2:?usage: $0 <eventId> '<payload json>'}"
# 実行に一意な名前を付け、前の実行と取り違えないようにする
EXEC_NAME="$(printf %s "${EVENT_ID}" | tr -c 'A-Za-z0-9_-' '-' | cut -c1-50)-$(date +%s)"

echo ">> invoke (async Event) ${DF}:${VER} eventId=${EVENT_ID} name=${EXEC_NAME}"
# Event 呼び出しなので応答本文は空。出力ファイルは捨てる
aws lambda invoke \
  --function-name "${DF}:${VER}" \
  --invocation-type Event \
  --durable-execution-name "$EXEC_NAME" \
  --payload "$PAYLOAD" \
  --cli-binary-format raw-in-base64-out \
  $PROFILE_OPT --region "$REGION" \
  /dev/null >/dev/null

echo ">> waiting for the durable execution to appear & finish ..."
# 待っている間の CLI のエラー（認証切れ・権限不足など）は、タイムアウトしたときに表示する
ERR="$(mktemp)"
trap 'rm -f "$ERR"' EXIT
ARN=""
STATUS="NOT_FOUND"
for i in $(seq 1 100); do
  # 実行名でサーバー側で絞り込む（API は --qualifier と実行名の同時指定を受け付けない）。
  # ARN が取れたら以降は固定し、状態だけを取り直す。
  if [ -z "$ARN" ] || [ "$ARN" = "None" ]; then
    ARN=$(aws lambda list-durable-executions-by-function \
      --function-name "$DF" \
      --durable-execution-name "$EXEC_NAME" \
      $PROFILE_OPT --region "$REGION" \
      --query "DurableExecutions[0].DurableExecutionArn" \
      --output text 2>"$ERR" || echo "")
  fi
  if [ -n "$ARN" ] && [ "$ARN" != "None" ]; then
    STATUS=$(aws lambda get-durable-execution \
      --durable-execution-arn "$ARN" \
      $PROFILE_OPT --region "$REGION" \
      --query "Status" --output text 2>"$ERR" || echo "UNKNOWN")
    echo "   [$i] status=$STATUS"
    case "$STATUS" in
      SUCCEEDED|FAILED|STOPPED|TIMED_OUT) break ;;
    esac
  fi
  sleep 3
done

case "$STATUS" in
  SUCCEEDED|FAILED|STOPPED|TIMED_OUT) ;;
  *)
    echo "!! timed out waiting (status=$STATUS, name=$EXEC_NAME)" >&2
    echo "   中止シナリオなら、判断（send-decision.sh）が届いていない可能性があります。ARN=$ARN" >&2
    [ -s "$ERR" ] && { echo "   last error:" >&2; cat "$ERR" >&2; }
    exit 1 ;;
esac

echo ">> final:"
aws lambda get-durable-execution \
  --durable-execution-arn "$ARN" \
  $PROFILE_OPT --region "$REGION" \
  --output json | python3 -c "import sys,json;d=json.load(sys.stdin);print(json.dumps({k:d.get(k) for k in ['Status','StartTimestamp','EndTimestamp']},default=str,ensure_ascii=False,indent=2));print('--- Result ---');print(d.get('Result',''));print('--- Error ---');print(json.dumps(d.get('Error'),ensure_ascii=False))"
echo "ARN=$ARN"
[ "$STATUS" = "SUCCEEDED" ]
