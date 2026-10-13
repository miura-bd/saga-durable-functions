/**
 * durable functions 版 SAGA オーケストレータ。
 *
 * 記事の柱:
 *  - 原典のモデル（終了時に補償とパラメータを登録 / セーブポイント）をコードでそのまま書く
 *  - 補償は「ステップの隣」に書き、成功時にスタックへ積む（配列に積むだけ）
 *  - 中止の決定を先に記録してから、補償スタック（当日の操作の打ち消し）を逆順に実行（原典 abort-saga）
 *  - 「配信開始」以降はピボットで戻さない
 *
 * すべての副作用は context.step でラップ（チェックポイント＋自動リトライ＋リプレイ安全）。
 */
import {
  withDurableExecution,
  type DurableContext,
} from "@aws/durable-execution-sdk-js";
import type { BatchResult } from "@aws/durable-execution-sdk-js";
import type {
  CompensationEntry,
  SagaInput,
  SagaResult,
  SagaStepName,
} from "../common/domain.js";
import { partners, resources, sales, trace, viewingPage } from "../common/mocks.js";

export const handler = withDurableExecution(
  async (event: SagaInput, context: DurableContext): Promise<SagaResult> => {
    const { eventId, eventName, fault } = event;
    const completedSteps: SagaStepName[] = [];
    const compensatedSteps: SagaStepName[] = [];
    const notes: string[] = [];

    // 補償スタック: 原典の「各トランザクション終了時に補償とパラメータを登録」。
    // ただのメモリ上の配列。step 成功のたびに push する（リプレイ時も同じ順で再構築される）。
    const compensations: CompensationEntry[] = [];
    // 補償可能フェーズを出たら false にする目印。中止の補償に入ったとき（補償中の失敗で補償をもう一度
    // 最初から回し、外部への中止連絡が 2 回飛ぶのを防ぐ）と、配信開始のピボットに入るとき（以降は戻さない）。
    let compensable = true;

    try {
      // --- 正常系 1: 配信リソース確保 ---
      await context.step("reserve_streaming", async () => {
        if (fault?.failStep === "reserve_streaming") {
          throw new Error("injected failure at reserve_streaming");
        }
        await resources.reserve(eventId);
      });
      completedSteps.push("reserve_streaming");
      compensations.push({
        step: "reserve_streaming",
        label: "配信リソースを解放",
        params: { eventId },
      });

      // --- 正常系 2: 購入者向けの視聴ページを公開（チケットの販売は前の週から受付中） ---
      await context.step("open_viewing_page", async () => {
        if (fault?.failStep === "open_viewing_page") {
          throw new Error("injected failure at open_viewing_page");
        }
        await viewingPage.open(eventId);
      });
      completedSteps.push("open_viewing_page");
      compensations.push({
        step: "open_viewing_page",
        label: "視聴ページを閉じる",
        params: { eventId },
      });

      // --- 正常系 3: 外部配信先へ配信情報を連絡 ---
      await context.step("notify_partners", async () => {
        if (fault?.failStep === "notify_partners") {
          throw new Error("injected failure at notify_partners");
        }
        await partners.notifyStreamInfo(eventId);
      });
      completedSteps.push("notify_partners");
      compensations.push({
        step: "notify_partners",
        label: "外部配信先へ中止連絡",
        params: { eventId },
      });

      // --- 正常系 4: 開催可否の判断待ち（コールバック or 開演時刻） ---
      // 主催者のコールバックと「開演時刻の到来」の競合を parallel + minSuccessful:1 で表現。
      // cancel=true のときはテスト用コールバック関数が cancel を送る。
      const decision = await context.parallel<"go" | "cancel">(
        "await_go_decision",
        [
          // 枝 A: 主催者の判断（コールバック）。cancel 入力時は external から cancel が来る。
          async (ctx) =>
            ctx.waitForCallback<"go" | "cancel">(
              "organizer_decision",
              async (callbackId) => {
                // submitter は「callbackId を外部システムへ渡す」場所。SDK 内部で step（organizer_decision-submitter）
                // として実行され、渡るのは logger だけの WaitForCallbackContext なので、中で durable step は呼べない。
                // 副作用は直接 await する（チェックポイント済みならリプレイで再実行されないが、step 完了前に落ちると
                // 再実行され得るので、上書き Put のような冪等な書き込みにしておく）。
                await emitCallbackId(eventId, callbackId, event.cancel);
              },
              // 開演までの判断待ち。実行タイムアウト（スタックで 12 時間）から、補償の所要時間を引いた余裕を残す
              { timeout: { hours: 10 } },
            ),
          // 枝 B: 開演時刻の到来（ここでは短い wait で代用）。到来したら "go"。
          async (ctx) => {
            await ctx.wait("showtime", { seconds: event.showtimeSeconds ?? (event.cancel ? 3600 : 5) });
            return "go" as const;
          },
        ],
        { completionConfig: { minSuccessful: 1 } },
      );

      // 判定: minSuccessful:1 なので、先に返ってきた枝で決まる（開演時刻が先に来れば開催。そのあとに届いた
      // 中止のコールバックは使わない）。2 つの枝がそろって返っていた場合は、主催者の中止判断を優先する
      // （防御的な保険。この構成では先に返った 1 本で完了するので、ふつうはこの分岐に入らない）。
      const results = (decision as BatchResult<"go" | "cancel">).getResults();
      // callback の値はデシリアライザ次第で `"cancel"`（クォート付き文字列）で来ることがある。
      // 正規化してから判定する（実機で、クォート付きの値が届くことがあった）。
      const norm = (v: unknown): string =>
        typeof v === "string" ? v.replace(/^"|"$/g, "") : String(v);
      const verdict: "go" | "cancel" = results.some((r) => norm(r) === "cancel")
        ? "cancel"
        : "go";
      completedSteps.push("await_go_decision");

      if (verdict === "cancel") {
        notes.push("主催者が中止を発動。補償フェーズへ。");
        compensable = false;
        // 中止の決定を先に記録してから補償（原典: abort-saga をログに記録してから補償）。
        await context.step("record_cancellation", async () => {
          await sales.stopAndShowCancelled(eventId); // 販売停止を先に
        });

        // 当日に行った操作を逆順に打ち消す（後退回復）
        await runCompensations(context, event, compensations, compensatedSteps, notes);

        return {
          eventId,
          outcome: "cancelled_and_compensated",
          completedSteps,
          compensatedSteps,
          notes,
        };
      }

      // --- 正常系 5: 配信開始（ピボット。以降は戻さない） ---
      // 失敗しても補償には入らず、実行を失敗させる（SF 版の StartStreaming に Catch がないのと同じ）。
      compensable = false;
      await context.step("start_streaming", async () => {
        await resources.start(eventId);
      });
      completedSteps.push("start_streaming");
      notes.push(`${eventName} は予定どおり配信開始（補償不要）。`);

      return {
        eventId,
        outcome: "streamed",
        completedSteps,
        compensatedSteps,
        notes,
      };
    } catch (err) {
      // 補償中・ピボット後の失敗は補償し直さず、実行を失敗させて人手に渡す。
      // （disableCompensableGuard は対照実験用。目印を無視すると、中止の補償の失敗が準備の失敗と同じ扱いになる）
      if (!compensable && !fault?.disableCompensableGuard) throw err;
      // 当日の準備（正常系 1〜3）での失敗は「中止」ではない。販売を止めてから、当日に行った操作だけを
      // 逆順に戻し（後退回復）、中止にするかどうかは人手に渡す。
      notes.push(`失敗を検知: ${(err as Error).message}。当日の操作を逆順に戻して人手へ。`);
      await context.step("record_abort", async () => {
        await sales.stop(eventId);
      });
      await runCompensations(context, event, compensations, compensatedSteps, notes);
      notes.push("中止かどうかは人が判断する。");
      return {
        eventId,
        outcome: "rolled_back_for_review",
        completedSteps,
        compensatedSteps,
        notes,
      };
    }
  },
);

/**
 * 補償スタックを逆順に実行する（当日に行った操作の打ち消し）。補償自体も durable ステップ。
 */
async function runCompensations(
  context: DurableContext,
  event: SagaInput,
  compensations: CompensationEntry[],
  compensatedSteps: SagaStepName[],
  notes: string[],
): Promise<void> {
  const { eventId, fault } = event;

  // 補償スタックの中身を invocation ごとにログへ出す。配列はどこにも保存していないので、
  // 再開した invocation で同じ中身が出ていれば、リプレイで組み立て直されたことになる。
  trace.emit("compensation_stack", { eventId, stack: compensations.map((c) => c.step) });

  // 1 つの補償を durable step として実行する。故障注入は実験用（domain.ts の FaultInjection）。
  const compensate = async (
    entry: CompensationEntry,
    stepName: string,
    action: () => Promise<void>,
  ): Promise<void> => {
    await context.step(
      stepName,
      async (sctx) => {
        if (fault?.failCompensation === entry.step) {
          throw new Error(`injected failure at ${stepName}`);
        }
        await action();
        // 実験 2（実機）: 副作用を書いた直後・step が結果を記録する前に落とす
        if (fault?.crashAfterCompensationSideEffect === entry.step) {
          if (await markCrashOnce(eventId, `in#${stepName}`)) process.exit(1);
        }
        // 実験 2（ローカル）: 送れたのに 1 回目の試行だけ失敗に見せる → リトライで本体が再実行される
        if (fault?.failAfterCompensationSideEffect === entry.step && sctx.attempt === 1) {
          throw new Error(`simulated timeout after ${stepName} was done`);
        }
      },
      // 合計 3 回まで試行、1 秒間隔
      { retryStrategy: (_err, attempt) => ({ shouldRetry: attempt < 3, delay: { seconds: 1 } }) },
    );
    compensatedSteps.push(entry.step);
    // 実験 1（実機）: 補償が終わった直後（step の外）で落とす。再開後は完了済みの補償をリプレイで飛ばす
    if (fault?.crashBetweenCompensations === entry.step) {
      if (await markCrashOnce(eventId, `after#${stepName}`)) process.exit(1);
    }
  };

  // 補償スタックを逆順(LIFO)に実行する。実際の順は 中止連絡 → 視聴ページを閉じる → 配信リソース解放。
  for (const entry of [...compensations].reverse()) {
    switch (entry.step) {
      case "open_viewing_page":
        await compensate(entry, "compensate_open_viewing_page", () => viewingPage.close(eventId));
        break;
      case "notify_partners":
        await compensate(entry, "compensate_notify_partners", () =>
          partners.notifyCancellation(eventId, { disableIdempotency: fault?.disableIdempotency }),
        );
        notes.push("外部配信先へ中止連絡（1 ステップのみ。リマインドなどは作り込まない）。");
        break;
      case "reserve_streaming":
        await compensate(entry, "compensate_reserve_streaming", () => resources.release(eventId));
        break;
      default:
        break;
    }
  }
}

// ---- 故障注入とコールバック ID の受け渡しヘルパ ----

/**
 * クラッシュ・マーカーを「初回だけ」作る。条件付き書き込み（attribute_not_exists）で
 * 既に存在すれば ConditionalCheckFailed になる。
 * - 作れた（初回）: true を返す → 呼び出し側がクラッシュする
 * - 作れなかった（再開後）: false を返す → クラッシュしない
 * state テーブルに `crash#<name>` 行として残すので、「再開の痕跡」として読める。
 */
async function markCrashOnce(
  eventId: string,
  name: string,
): Promise<boolean> {
  const { ddb, STATE } = await import("../common/mocks.js");
  const { PutCommand } = await import("@aws-sdk/lib-dynamodb");
  try {
    await ddb.send(
      new PutCommand({
        TableName: STATE,
        Item: {
          eventId,
          stateKey: `crash#${name}`,
          value: { crashedAt: new Date().toISOString(), pid: process.pid },
        },
        ConditionExpression:
          "attribute_not_exists(eventId) AND attribute_not_exists(stateKey)",
      }),
    );
    return true; // 作れた＝初回
  } catch (e) {
    if ((e as { name?: string }).name === "ConditionalCheckFailedException") {
      return false; // 既にある＝再開後の invocation
    }
    throw e;
  }
}

/** コールバック ID を state テーブルへ書き出す（検証スクリプトが読む）。 */
async function emitCallbackId(
  eventId: string,
  callbackId: string,
  cancel: boolean,
): Promise<void> {
  const { ddb, STATE } = await import("../common/mocks.js");
  const { PutCommand } = await import("@aws-sdk/lib-dynamodb");
  await ddb.send(
    new PutCommand({
      TableName: STATE,
      Item: {
        eventId,
        stateKey: "callback",
        value: { callbackId, expectedDecision: cancel ? "cancel" : "go" },
        at: new Date().toISOString(),
      },
    }),
  );
}
