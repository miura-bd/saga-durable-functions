#!/usr/bin/env bash
# Step Functions 版 SAGA を 1 実行起動し、完了まで待って結果を表示する。
# 使い方: scripts/run-sfn.sh <name> '<input json>'
set -euo pipefail
export AWS_PAGER=""
# AWS_PROFILE が設定されているときだけ --profile を付ける（環境変数の認証情報でも動くように）
PROFILE_OPT="${AWS_PROFILE:+--profile $AWS_PROFILE}"
REGION="${AWS_REGION:-ap-northeast-1}"
# ステートマシン ARN はデプロイ後の CfnOutput から渡す（例: export STATE_MACHINE_ARN=...）
SM="${STATE_MACHINE_ARN:?set STATE_MACHINE_ARN to the deployed state machine ARN}"

NAME="${1:?usage: $0 <name> '<input json>'}"
INPUT="${2:?usage: $0 <name> '<input json>'}"

ARN=$(aws stepfunctions start-execution \
  --state-machine-arn "$SM" \
  --name "$NAME-$(date +%s)" \
  --input "$INPUT" \
  $PROFILE_OPT --region "$REGION" \
  --query 'executionArn' --output text)
echo ">> started: ${ARN##*:}"

for i in $(seq 1 60); do
  S=$(aws stepfunctions describe-execution --execution-arn "$ARN" \
    $PROFILE_OPT --region "$REGION" --query 'status' --output text)
  echo "   [$i] $S"
  case "$S" in SUCCEEDED|FAILED|TIMED_OUT|ABORTED) break ;; esac
  sleep 3
done
echo "ARN=$ARN"
case "$S" in
  SUCCEEDED|FAILED|TIMED_OUT|ABORTED) ;;
  *) echo "!! timed out waiting (status=$S)" >&2; exit 1 ;;
esac
[ "$S" = "SUCCEEDED" ]
