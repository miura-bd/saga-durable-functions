#!/usr/bin/env bash
# 中止シナリオ用: durable 実行が emit した callbackId を state テーブルから拾い、
# 主催者の判断（cancel / go）をコールバックで送る。
# 使い方: scripts/send-decision.sh <eventId> <cancel|go>
set -euo pipefail
export AWS_PAGER=""
# AWS_PROFILE が設定されているときだけ --profile を付ける（環境変数の認証情報でも動くように）
PROFILE_OPT="${AWS_PROFILE:+--profile $AWS_PROFILE}"
REGION="${AWS_REGION:-ap-northeast-1}"
STATE_TABLE="${STATE_TABLE:?set STATE_TABLE to the deployed SagaState table name}"

EVENT_ID="${1:?usage: $0 <eventId> <cancel|go>}"
DECISION="${2:?usage: $0 <eventId> <cancel|go>}"
# cancel 以外はすべて開催（go）扱いになるので、打ち間違いはここで止める
case "$DECISION" in
  cancel|go) ;;
  *) echo "usage: $0 <eventId> <cancel|go>" >&2; exit 2 ;;
esac

# 待っている間の CLI のエラー（認証切れ・権限不足など）は、見つからなかったときに表示する
ERR="$(mktemp)"
trap 'rm -f "$ERR"' EXIT

echo ">> waiting for callbackId (eventId=$EVENT_ID) ..."
CB=""
for i in $(seq 1 40); do
  CB=$(aws dynamodb get-item --table-name "$STATE_TABLE" \
    --key "{\"eventId\":{\"S\":\"$EVENT_ID\"},\"stateKey\":{\"S\":\"callback\"}}" \
    $PROFILE_OPT --region "$REGION" \
    --query 'Item.value.M.callbackId.S' --output text 2>"$ERR" || echo "")
  if [ -n "$CB" ] && [ "$CB" != "None" ]; then
    echo "   got callbackId=$CB"
    break
  fi
  sleep 2
done
if [ -z "$CB" ] || [ "$CB" = "None" ]; then
  echo "!! callbackId not found" >&2
  [ -s "$ERR" ] && { echo "   last error:" >&2; cat "$ERR" >&2; }
  exit 1
fi

echo ">> sending decision=$DECISION"
aws lambda send-durable-execution-callback-success \
  --callback-id "$CB" \
  --result "\"$DECISION\"" \
  --cli-binary-format raw-in-base64-out \
  $PROFILE_OPT --region "$REGION" >/dev/null
echo "   sent."
