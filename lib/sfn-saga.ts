/**
 * Step Functions 版 SAGA。共通モックのビジネスロジックをワーカー Lambda として invoke する
 * （durable 版は同じロジックを同一プロセス内で直接呼ぶ。共有するのはロジックで実行トポロジは別）。
 *
 * 記事の比較用。durable 版との差を「オーケストレーション層の書き方」に絞る:
 *  - 補償は別ステートに固定で分かれ、Catch で補償チェーンへ飛ぶ
 *    （durable 版は補償を配列に push し、失敗時に逆順実行するだけだった）
 *  - 開催可否の分岐は Choice（durable は if 文）。正常系の失敗は Catch で補償チェーンへ飛ぶ
 *  - JSONata モード。入力(eventId/fault)は冒頭で変数に退避し、Catch 後も参照できるようにする
 *    （JSONPath 時代の「ResultPath で元入力を温存」に相当する作業）。
 */
import { Duration } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { IFunction } from "aws-cdk-lib/aws-lambda";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import type { Construct } from "constructs";

export function buildStateMachine(
  scope: Construct,
  worker: IFunction,
): sfn.StateMachine {
  const fn = worker.functionArn;

  const definition = {
    Comment:
      "SAGA for live-stream cancellation (Step Functions version). Mirrors the durable functions orchestrator.",
    QueryLanguage: "JSONata",
    StartAt: "Init",
    States: {
      // 入力を変数に退避（補償チェーンでも eventId/fault を使えるように）
      Init: {
        Type: "Pass",
        QueryLanguage: "JSONata",
        Assign: {
          eventId: "{% $states.input.eventId %}",
          fault: "{% $states.input.fault ? $states.input.fault : {} %}",
          cancel: "{% $states.input.cancel ? $states.input.cancel : false %}",
        },
        Next: "ReserveStreaming",
      },

      // 当日の準備（正常系 1〜3）の失敗は、durable 版の catch と同じく「中止」ではない。
      // 販売を止めてから、当日に行った操作だけを戻す（中止かどうかは人が判断する）。
      // --- 正常系 1: 配信リソース確保 ---
      // 失敗したら、販売を止めるだけ（成功済みのステップがないので戻すものはない）
      ReserveStreaming: task(fn, "reserve_streaming", {
        Next: "OpenViewingPage",
        Catch: [catchTo("RecordAbort")],
      }),
      // --- 正常系 2: 購入者向けの視聴ページを公開（チケットの販売は前の週から受付中） ---
      // 失敗したら、販売を止めて、成功済みの ReserveStreaming の補償（解放）だけを行う
      OpenViewingPage: task(fn, "open_viewing_page", {
        Next: "NotifyPartners",
        Catch: [catchTo("RecordAbortThenRelease")],
      }),
      // --- 正常系 3: 外部配信先へ連絡 ---
      // 失敗したら、販売を止めて、視聴ページを閉じ、配信リソースを解放する
      NotifyPartners: task(fn, "notify_partners", {
        Next: "AwaitGoDecision",
        Catch: [catchTo("RecordAbortThenClose")],
      }),
      // --- 正常系 4: 開催可否の判断待ち（簡略: 変数 cancel で分岐） ---
      // 実運用では waitForTaskToken + タイムアウトで「コールバック or 開演時刻」を表すが、
      // 比較の主眼は補償チェーンなので Choice で代用（記事で明記）。
      AwaitGoDecision: {
        Type: "Choice",
        QueryLanguage: "JSONata",
        Choices: [{ Condition: "{% $cancel = true %}", Next: "RecordCancellation" }],
        Default: "StartStreaming",
      },
      // --- 正常系 5: 配信開始（ピボット） ---
      // 以降は戻さないので Catch は付けない（durable 版もピボット後の失敗では補償しない）
      StartStreaming: task(fn, "start_streaming", { End: true }),

      // --- 中止: 販売停止・中止表示を先に記録 ---
      RecordCancellation: task(fn, "record_cancellation", {
        Next: "CompensateNotifyPartners",
      }),

      // --- 当日の準備の失敗時: 販売を止めて（durable 版の record_abort）、補償チェーンの途中へ合流 ---
      RecordAbort: task(fn, "abort_sales", { End: true }),
      RecordAbortThenRelease: task(fn, "abort_sales", {
        Next: "ReleaseStreaming",
      }),
      RecordAbortThenClose: task(fn, "abort_sales", {
        Next: "CloseViewingPage",
      }),

      // --- 補償チェーン（逆順。durable 版と同じ）: 外部中止連絡 → 視聴ページを閉じる → リソース解放 ---
      // 当日の準備の失敗時は、販売を止めたあと失敗した位置に応じて途中に合流する。
      CompensateNotifyPartners: task(fn, "compensate_notify_partners", {
        Next: "CloseViewingPage",
      }),
      CloseViewingPage: task(fn, "close_viewing_page", {
        Next: "ReleaseStreaming",
      }),
      ReleaseStreaming: task(fn, "release_streaming", {
        Next: "Done",
      }),
      Done: { Type: "Succeed" },
    },
  };

  const role = new iam.Role(scope, "SagaSfnRole", {
    assumedBy: new iam.ServicePrincipal("states.amazonaws.com"),
  });
  worker.grantInvoke(role);

  return new sfn.StateMachine(scope, "SagaStateMachine", {
    definitionBody: sfn.DefinitionBody.fromString(JSON.stringify(definition)),
    role,
    timeout: Duration.minutes(30),
    stateMachineType: sfn.StateMachineType.STANDARD,
    tracingEnabled: true,
  });
}

/** Lambda invoke タスク（JSONata）の共通形。退避済み変数 $eventId / $fault を使う。 */
function task(
  fn: string,
  action: string,
  rest: Record<string, unknown>,
): Record<string, unknown> {
  return {
    Type: "Task",
    QueryLanguage: "JSONata",
    Resource: "arn:aws:states:::lambda:invoke",
    Arguments: {
      FunctionName: fn,
      Payload: {
        action,
        eventId: "{% $eventId %}",
        fault: "{% $fault %}",
      },
    },
    ...rest,
  };
}

/** Catch 定義: 失敗したら指定の補償ステートへ。 */
function catchTo(next: string): Record<string, unknown> {
  return { ErrorEquals: ["States.ALL"], Next: next };
}
