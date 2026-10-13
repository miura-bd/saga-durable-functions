# 動かし方（ハンズオン手順）

builders.flash 記事「Lambda Durable Functions で、途中で落ちても続く SAGA を書く」のサンプルを、実際に手元で動かすための手順です。
ローカルテスト経路（AWS 不要・数秒）と、実機経路（AWS 利用料あり）の 2 つがあります。

記事の実験 1〜3（補償の途中で落ちた場合・補償の中で落ちた場合・補償そのものが失敗した場合）は、すべてローカルテストで確かめられます。
実験 1・2 の「本当に invocation を落として、別の invocation で再開させる」部分は、実機経路で確かめます。

## 必要なもの

- ローカルテストのみ：Node.js 22 以上（`node --version` で確認）と git。AWS アカウントは不要です。
- 実機も試す場合：追加で次のものが要ります。
  - AWS CLI v2（Durable Functions に対応した版。`aws lambda get-durable-execution help` が通れば対応版です）と、認証済みの AWS プロファイル
  - `jq`（手順の中で `cdk-outputs.json` から値を取り出すのに使います）
  - `python3`（`run-durable.sh` が結果の整形に使います）
  - bash（実機のスクリプトは bash で動かします。Windows は WSL を使ってください）
- Durable Functions の関数の対応リージョンは順次広がっているので、使う前に AWS の公式情報で確認してください。この記事は ap-northeast-1 で確認しています。

## ローカルテスト経路

> **macOS の zsh を使っている場合**：zsh は既定では、貼り付けたコマンドの `# コメント` をコメントとして扱いません。
> 行頭なら `command not found: #` と表示され、行末なら引数として渡ってしまいます。
> 最初に `setopt interactivecomments` を実行するか、`bash` と打って bash に切り替えてから、以下のコマンドを貼り付けてください。

```bash
# サンプルを取得して、そのディレクトリで作業します
git clone https://github.com/miura-bd/saga-durable-functions.git
cd saga-durable-functions

npm ci          # package-lock.json どおりに依存を入れます
npm test        # 補償の実験 1〜3 とその対照（AWS 不要）
```

最後に `# pass 5` と `# fail 0` が出れば成功です（表示は `ok 1 - …` の形式です。環境によっては `✔` 付きの形式で表示されることもあります）。
公式のテストランナー（`LocalDurableTestRunner`）でオーケストレータを本物のリプレイに乗せて流し、DynamoDB はインメモリに差し替えています。

| テスト | 確かめること |
|---|---|
| 1 | 実験 1：補償スタックを保存していなくても、別の invocation で同じ中身に組み立て直される |
| 2・3 | 実験 2 とその対照：中止連絡の本体が再実行されても、冪等キーがあれば 1 回、なければ 2 回 |
| 4・5 | 実験 3 とその対照：補償の途中で失敗したとき、`compensable` の目印があればやり直さず失敗させ、無視すると「準備の失敗」扱いになる |

ローカルのランナーでは `process.exit` で落ちた invocation からの再開までは再現できないため、実験 1 の invocation の区切りは開催可否のコールバック待ちで、実験 2 の本体の再実行は step のリトライで作っています。
補償のリトライ待ちなどを実時間で待つので、全体で十数秒かかります。

## 実機経路

> zsh を使っている場合は、ローカルテスト経路の注記のとおり、先に `setopt interactivecomments` を実行するか bash に切り替えてください。

まず、どのアカウントで操作しているかを確認し、リージョンを固定します。
`AWS_PROFILE` は自分のプロファイル名（`aws configure list-profiles` で一覧が出ます）に読み替えてください。
環境変数で認証している場合（CloudShell など）は、`AWS_PROFILE` の行は飛ばして構いません。

```bash
aws configure list-profiles                  # 使えるプロファイル名の一覧
export AWS_PROFILE=my-sandbox                 # 上の一覧から自分のものに。SSO なら先に aws sso login --profile my-sandbox
export AWS_DEFAULT_REGION=ap-northeast-1      # 以降すべてこのリージョンで実行します（deploy 先もこれで決まります）
export AWS_REGION="$AWS_DEFAULT_REGION"
export AWS_PAGER=""                           # 結果が pager に入って止まらないように
aws sts get-caller-identity                   # 対象アカウントが表示されれば OK
```

デプロイします。
bootstrap はアカウント×リージョンごとに 1 回だけ必要で、CDK 用の基盤スタック（`cdk destroy` では消えません）を作ります。
`npx cdk` はリポジトリ同梱の CDK を使うので、別途インストールは不要です。

```bash
npx cdk bootstrap            # そのアカウント×リージョンで初回のみ
npx cdk deploy --outputs-file cdk-outputs.json   # IAM 変更の確認で y を入力します
```

deploy の途中で `INFO Modifying an existing lambda to use durability will trigger a resource replacement` や `feature flags are not configured` といった表示が出ることがありますが、どちらも失敗ではありません（前者は既存の関数に後から durable を付けるときの注意で、新規デプロイでは関係ありません）。

デプロイが終わると、リポジトリのルートに `cdk-outputs.json` が作られ、関数名やテーブル名が出力されます（アカウント固有の値を含むので、`.gitignore` で Git の対象から外してあります）。
中身はこういう形です（ほかに `DurableFunctionArn` も出力されます）。

```json
{
  "SagaDurableFunctionsStack": {
    "DurableFunctionName": "SagaDurableFunctionsStack-DurableSaga...",
    "WorkerFunctionName":  "SagaDurableFunctionsStack-Worker...",
    "StateTable":          "SagaDurableFunctionsStack-SagaState...",
    "IdempotencyTable":    "SagaDurableFunctionsStack-Idempotency...",
    "StateMachineArn":     "arn:aws:states:ap-northeast-1:...:stateMachine:SagaStateMachine..."
  }
}
```

このキーを環境変数に入れます（`STATE_TABLE` は、コールバック待ちの callbackId や、各処理が実際に走った回数を置く SAGA 状態テーブルです）。

```bash
export STACK=SagaDurableFunctionsStack
export DURABLE_FN=$(jq -r ".\"$STACK\".DurableFunctionName" cdk-outputs.json)
export STATE_TABLE=$(jq -r ".\"$STACK\".StateTable"        cdk-outputs.json)
export STATE_MACHINE_ARN=$(jq -r ".\"$STACK\".StateMachineArn" cdk-outputs.json)

# Durable Functions の関数は修飾子つき（バージョン）で呼びます。publish-version でバージョンを発行し、その番号を使います。
# コードを変えて再デプロイしたら、この publish-version もやり直してバージョンを取り直してください。
export DURABLE_VER=$(aws lambda publish-version --function-name "$DURABLE_FN" --query Version --output text)
```

> **新しいターミナルを開いたとき**は、ここまでの環境変数が消えています。
> zsh の場合は、まず `setopt interactivecomments` をもう一度実行するか、`bash` に切り替えてください。
> そのうえでリポジトリのルートに `cd` してから、上の 2 つのブロック（`AWS_PROFILE`〜`AWS_PAGER` と、`STACK`〜`STATE_MACHINE_ARN`）の `export` をもう一度実行してください（`DURABLE_VER` の行は除きます）。
> `DURABLE_VER` は publish-version をやり直さず、発行済みの最新バージョンを取ります。
> 下の「結果の確認」をするときは、`EID=<run-durable で使った eventId>` と `ARN=<run-durable が最後に表示した ARN>` も設定し直してください。
>
> ```bash
> export DURABLE_VER=$(aws lambda list-versions-by-function --function-name "$DURABLE_FN" \
>   --query "sort_by(Versions[?Version!='\$LATEST'], &to_number(Version))[-1].Version" --output text)
> ```

実験を流します。
この SAGA は当日の準備（1〜3）のあとに「開催か中止か」の判断をコールバックで待って一時停止します。
`run-durable.sh` はその判断待ちで止まるのでバックグラウンド（`&`）で起動し、数秒おいてから `send-decision.sh <eventId> cancel` で中止の判断を送ります（送ると補償へ進みます）。
`send-decision.sh` は callbackId が state テーブルに現れるまで内部で待つので、多少早く叩いても大丈夫です。
`run-durable.sh` は起動した実行に一意な名前を付けて、その実行が終わるまで待ち、最後に `ARN=...` を表示します。

落とす位置は入力の `fault` で指定します。
どれも「最初の 1 回だけ」`process.exit(1)` で invocation を落とし、別の invocation で再開するところまで流します。

| 実験 | 入力の `fault` | 落ちる位置 |
|---|---|---|
| 落とさない（比較用） | なし | — |
| 実験 1 | `{"crashBetweenCompensations":"notify_partners"}` | 中止連絡の補償が終わった直後、次の補償に進む前（記事の図の C） |
| 実験 2 | `{"crashAfterCompensationSideEffect":"notify_partners"}` | 中止連絡を送った直後、step が結果を保存する前（記事の図の B） |
| 実験 2 の対照 | `{"crashAfterCompensationSideEffect":"notify_partners","disableIdempotency":true}` | 同上。冪等キーを使わずに送る |

```bash
# 実験 1（FAULT を上の表の値に変えれば、ほかの実験も同じ手順で流せます）
FAULT='{"crashBetweenCompensations":"notify_partners"}'
EID=exp1-$(date +%s)     # eventId は実行ごとに新しくします
bash scripts/run-durable.sh "$EID" "{\"eventId\":\"$EID\",\"eventName\":\"HSF\",\"cancel\":true,\"fault\":$FAULT}" | tee "run-$EID.log" &
sleep 5
bash scripts/send-decision.sh "$EID" cancel
wait
ARN=$(grep '^ARN=' "run-$EID.log" | cut -d= -f2-)
```

`--- Result ---` の下に `"outcome":"cancelled_and_compensated"` と `"compensatedSteps":["notify_partners","open_viewing_page","reserve_streaming"]` が出れば完走です。

## 結果の確認

```bash
# invocation の数（落とさない場合は 2、実験 1・2 は 3）
aws lambda get-durable-execution-history --durable-execution-arn "$ARN" \
  --query "length(Events[?EventType=='InvocationCompleted'])"

# そのうち異常終了した invocation の数（落とさない場合は 0、実験 1・2 は 1）
# 異常終了は独立したイベントではなく、InvocationCompleted に Error が付く形で記録されます
aws lambda get-durable-execution-history --durable-execution-arn "$ARN" \
  --query "length(Events[?EventType=='InvocationCompleted' && InvocationCompletedDetails.Error!=null])"

# 中止連絡が実際に送られた回数（実験 2 は 1、実験 2 の対照は 2）
aws dynamodb get-item --table-name "$STATE_TABLE" \
  --key "{\"eventId\":{\"S\":\"$EID\"},\"stateKey\":{\"S\":\"calls#notify_cancellation\"}}" \
  --query "Item.n.N" --output text

# 補償スタックのログ（実験 1・2 は、落ちる前と再開後の 2 つの invocation で同じ中身が出ます）
LOG_GROUP=$(aws lambda get-function-configuration --function-name "$DURABLE_FN" \
  --query "LoggingConfig.LogGroup" --output text)
aws logs filter-log-events --log-group-name "$LOG_GROUP" \
  --filter-pattern "\"compensation_stack\" \"$EID\"" --query "events[].message" --output text
```

ほかの処理が走った回数も、`calls#<処理名>` の行で同じように確かめられます（`reserve_streaming`・`open_viewing_page`・`notify_partners`・`close_viewing_page`・`release_streaming`）。どの実験でも 1 になります。

## Step Functions 版

記事の「参考：Step Functions で書くと」で触れた Step Functions 版も、同じスタックに入っています（判断待ちのコールバックは省き、入力の `cancel` で分岐します）。

```bash
EID=sfn-$(date +%s)
bash scripts/run-sfn.sh sfn-cancel "{\"eventId\":\"$EID\",\"eventName\":\"HSF\",\"cancel\":true}"
```

Step Functions のコンソールで実行を開くと、補償チェーンを通った様子をグラフで確かめられます。
`"cancel":false,"fault":{"failStep":"notify_partners"}` にすると、準備の失敗で `Catch` から補償チェーンの途中に合流する経路を通ります。

## うまくいかないとき

- `node: command not found` / `npm: command not found`：Node.js 22 以上を入れ、ターミナルを開き直します。
- `npm test` が失敗：`npm ci` が完了しているか、リポジトリのルートで実行しているかを確認します。
- `Unable to locate credentials` や `AccessDenied`：AWS 認証が未設定か権限不足です。`aws sts get-caller-identity` を確認し、bootstrap/deploy には検証用アカウントの管理者相当の権限を使ってください。
- 関数が見つからない：deploy と実行で**リージョンがずれて**います。`AWS_REGION` を export してから deploy し直すか、実行側を deploy したリージョンにそろえます。
- `run-durable.sh` が `DURABLE_VER: run publish-version and export DURABLE_VER` で止まる：`DURABLE_VER` が未設定です。publish-version（新しいターミナルなら上の list-versions-by-function）で取り直してください。
- `run-durable.sh` が `ResourceNotFoundException` で止まる：存在しないバージョンを指定しています。publish-version からやり直してください。
- `send-decision.sh` が 1〜2 分ほど待ったあと `callbackId not found` で止まる：`run-durable.sh` の起動に失敗しているか、`STATE_TABLE` の値か eventId がずれています。run-durable 側の出力を確認してください（CLI のエラーが出ていれば `last error:` の後ろに表示されます）。
- `run-durable.sh` が `timed out waiting` で終わる：`last error:` が出ていれば、認証切れや権限不足です。出ていなければ、判断（cancel）が届かず、実行が判断待ちのまま残っています（約 1 時間たつと開演時刻扱いで配信開始に進みます）。表示された ARN を使って止めてから、eventId を新しくしてやり直します。

  ```bash
  aws lambda stop-durable-execution --durable-execution-arn "<表示された ARN>"
  ```

- `get-durable-execution` 系が `Invalid choice`（不明なサブコマンド）：AWS CLI が古いです。Durable Functions に対応した版へ上げてください。

## 後片付け

試し終えたら、デプロイしたときと同じプロファイル・リージョン（上の `export` を済ませた状態）でスタックを削除します。
テーブル・関数・ステートマシン・ロググループもまとめて消えます。

```bash
npx cdk destroy            # 削除の確認で y を入力します
```

bootstrap で作った CDK 基盤スタック（`CDKToolkit`）は残ります。
同じアカウント×リージョンで他の CDK アプリを使っている場合は共有しているので、消さないでください。
検証専用のアカウントで不要になった場合だけ、CloudFormation から削除します。
中のアセット用 S3 バケットは保持設定のため残ります。
バージョニングが有効なので、古いバージョンも含めて空にしてから（コンソールの「空にする」を使うと簡単です）別途削除します。
ECR リポジトリはスタックと一緒に削除されます（このサンプルはコンテナイメージを使わないので空のままです）。
