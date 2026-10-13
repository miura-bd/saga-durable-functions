# 「Lambda Durable Functions で、途中で落ちても続く SAGA を書く」のサンプル

builders.flash 寄稿記事（2026-10）のサンプル実装です。
架空の野外フェス「Hokkai Sound Fes」の有料ライブ配信で、開演当日に中止が決まったときの補償（当日の準備の巻き戻し）を SAGA パターンで書き、補償の途中でわざと Lambda を落として、続きから進むか・中止連絡が二重に飛ばないか・補償が失敗しても中止を中止のまま扱えるかを確かめます。

比較用に、同じ補償を Step Functions でも書いています。
両版は同じモック（配信リソース・視聴ページ・外部配信先・販売＋失敗注入）を呼ぶので、差はオーケストレーション層だけに出ます。

## 構成

```
bin/
  saga-durable-functions.ts  CDK アプリのエントリ
src/
  common/domain.ts        ドメインモデルと失敗注入の指定（両版で共有）
  common/mocks.ts         配信リソース・視聴ページ・外部配信先・販売のモック（副作用と呼び出し回数を DynamoDB に記録）
  worker/handler.ts       ワーカー Lambda（Step Functions 版が action 分岐で呼ぶ）
  durable/orchestrator.ts Durable Functions 版 SAGA（補償スタック・コールバック待ち・compensable の目印）
lib/
  saga-durable-functions-stack.ts  CDK スタック（DynamoDB×2・Lambda×2・Step Functions）
  sfn-saga.ts                      Step Functions 版ステートマシン（JSONata・ASL 直書き）
scripts/
  run-durable.sh          Durable Functions の実行を起動し、完了まで待つ
  run-sfn.sh              Step Functions の実行を起動し、完了まで待つ
  send-decision.sh        callbackId を拾って、開催可否の判断（cancel / go）を送る
test/
  saga-compensation.test.ts  記事の実験 1〜3 とその対照（公式のテストランナーで実行。AWS 不要）
  helpers/memory-ddb.ts      テスト用のインメモリ DynamoDB
docs/
  HANDS-ON.md             動かし方（ローカルテスト・実機で実験 1・2 を流す手順・結果の確認）
  production-notes.md     本番の補償処理にする前のメモ
  figures/                記事の図（fig1・fig4・fig5。番号は記事の作図時のもの）
```

## 正常系と中止時の流れ

Durable Functions の実行は、開演当日の朝に公演日ごとに 1 つ起動します（実行タイムアウト 12 時間）。
準備のあと開演まで主催者の判断を待ち（最長 10 時間）、中止が決まると、その判断がコールバックで実行に届いて補償に入ります。

1. 配信リソースを確保する（補償：解放する）
2. 購入者向けの視聴ページを公開する（補償：視聴ページを閉じる）
3. 外部の配信先へ「配信します」と連絡する（補償：「中止します」と連絡する）
4. 開催可否の判断を待つ（主催者のコールバックか開演時刻）
5. 配信を開始する（ピボット。以降は戻さない）

中止のときは、販売停止と中止表示を記録してから、補償を逆順（中止連絡 → 視聴ページを閉じる → 解放）に実行します。
当日の準備（1〜3）で失敗したときは中止にせず、販売を止めて当日の操作だけを逆順に戻し、中止にするかどうかは人に任せます。

## ローカルテスト（AWS 不要）

```bash
npm ci
npm test        # 5 件 pass（実験 1〜3 とその対照）
```

## 実機で動かす

デプロイ、実験 1・2 の流し方、結果の確認、後片付けは [`docs/HANDS-ON.md`](docs/HANDS-ON.md) を参照してください。
実機では Lambda・DynamoDB・Step Functions の利用料がかかります。試し終えたら `npx cdk destroy` で片付けてください。

## ライセンス

[MIT-0](LICENSE)

## 前提

- Node.js 22 / AWS CDK v2 / TypeScript（ESM）
- `@aws/durable-execution-sdk-js`（テストは `@aws/durable-execution-sdk-js-testing`）
- 実機の手順：Durable Functions に対応した AWS CLI v2、`jq`、`python3`、bash（Windows は WSL）
- Durable Functions が利用できるリージョン（検証は ap-northeast-1）
