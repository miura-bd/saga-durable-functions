/**
 * ローカルテスト（AWS 不要）: SAGA の補償を、公式のテストランナー（LocalDurableTestRunner）で
 * 本物の durable のリプレイに乗せて確かめる。DynamoDB は test/helpers/memory-ddb.ts のインメモリ版。
 *
 *  - 実験 1: 補償スタック（ただの配列）は保存していないのに、別の invocation で同じ中身に組み立て直される
 *  - 実験 2: 補償の step 本体が再実行されると（at-least-once）、中止連絡は冪等キーで 1 回に抑えられる。
 *            冪等キーなし（disableIdempotency）だと二重連絡になる
 *  - 実験 3: 補償の途中で失敗したとき、compensable の目印があれば補償をやり直さずに実行を失敗させる。
 *            目印を無視すると、中止が「準備の失敗」として扱い直され、中止表示が消える
 *
 * ローカルのランナーは invocation の異常終了（process.exit）からの再開を再現できないので、
 * 実験 1 の invocation の区切りは開催可否のコールバック待ち、実験 2 の再実行は step のリトライで作る。
 * 本当にクラッシュさせての確認は実機で行う（crashBetweenCompensations / crashAfterCompensationSideEffect）。
 *
 * 実行: npx tsx --test test/saga-compensation.test.ts
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { LocalDurableTestRunner, WaitingOperationStatus } from "@aws/durable-execution-sdk-js-testing";
import { resetMemoryDdb, stateValue, callCount } from "./helpers/memory-ddb.js";
import type { FaultInjection, SagaInput, SagaResult } from "../src/common/domain.js";

const { trace } = await import("../src/common/mocks.js");
const { handler } = await import("../src/durable/orchestrator.js");

/** 補償スタックのトレース（invocation ごとに 1 行） */
let stacks: string[][] = [];

before(() => LocalDurableTestRunner.setupTestEnvironment({ skipTime: false }));
after(() => LocalDurableTestRunner.teardownTestEnvironment());
beforeEach(() => {
  resetMemoryDdb();
  stacks = [];
  trace.emit = (type, data) => {
    if (type === "compensation_stack") stacks.push(data.stack as string[]);
  };
});

/** 中止シナリオを 1 回流す */
async function runCancel(eventId: string, fault?: FaultInjection) {
  const runner = new LocalDurableTestRunner<SagaResult>({ handlerFunction: handler });
  // 開演時刻の wait は長めにして、主催者の中止判断（コールバック）が先に届くようにする
  const input: SagaInput = { eventId, eventName: "Hokkai Sound Fes Day1", cancel: true, fault, showtimeSeconds: 30 };
  // 主催者の中止判断（waitForCallback）を、実行を始める前に名前で押さえておく
  const decision = runner.getOperation("organizer_decision");
  const running = runner.run({ payload: input });
  await decision.waitForData(WaitingOperationStatus.SUBMITTED);
  // 最初の invocation が一時停止（コールバック待ち）に入ってから送る。ローカルのランナーは、invocation が
  // 走っている最中に届いたコールバックでは次の invocation を起こさず、開演時刻の wait の満了まで待ってしまうため
  await new Promise((r) => setTimeout(r, 500));
  await decision.sendCallbackSuccess(JSON.stringify("cancel"));
  return running;
}

test("実験1: 補償スタックは保存していないのに、別の invocation で同じ中身に組み立て直される", async () => {
  const ex = await runCancel("t1");
  assert.equal(ex.getStatus(), "SUCCEEDED");
  assert.equal(ex.getResult()?.outcome, "cancelled_and_compensated");
  // コールバック待ちで一時停止したので、invocation は 2 回以上に分かれている
  assert.ok(ex.getInvocations().length >= 2, `invocations=${ex.getInvocations().length}`);
  // 正常系 1〜3 の本体は最初の invocation で 1 回ずつしか走っていない（再開後はリプレイで保存結果を使う）
  assert.equal(callCount("t1", "reserve_streaming"), 1);
  assert.equal(callCount("t1", "open_viewing_page"), 1);
  assert.equal(callCount("t1", "notify_partners"), 1);
  // それでも、補償に入った invocation では配列が 3 件そろっている（push がリプレイで再実行された）
  assert.deepEqual(stacks.at(-1), ["reserve_streaming", "open_viewing_page", "notify_partners"]);
  // 逆順に打ち消され、各補償は 1 回ずつ
  assert.deepEqual(ex.getResult()?.compensatedSteps, ["notify_partners", "open_viewing_page", "reserve_streaming"]);
  assert.equal(callCount("t1", "notify_cancellation"), 1);
  assert.equal(callCount("t1", "close_viewing_page"), 1);
  assert.equal(callCount("t1", "release_streaming"), 1);
  assert.equal(stateValue("t1", "sales"), "stopped_cancelled");
});

test("実験2: 補償の本体が再実行されても、冪等キーがあれば中止連絡は 1 回", async () => {
  const ex = await runCancel("t2", { failAfterCompensationSideEffect: "notify_partners" });
  assert.equal(ex.getStatus(), "SUCCEEDED");
  // 中止連絡の step は 2 回試行された（1 回目は送れたのに失敗に見えた）
  const op = ex.getOperations().find((o) => o.getName() === "compensate_notify_partners");
  assert.equal(op?.getStepDetails()?.attempt, 2);
  // それでも外部へ送ったのは 1 回だけ
  assert.equal(callCount("t2", "notify_cancellation"), 1);
});

test("実験2 対照: 冪等キーなし(disableIdempotency)だと、本体の再実行で中止連絡が二重になる", async () => {
  const ex = await runCancel("t3", { failAfterCompensationSideEffect: "notify_partners", disableIdempotency: true });
  assert.equal(ex.getStatus(), "SUCCEEDED");
  assert.equal(callCount("t3", "notify_cancellation"), 2);
});

test("実験3: 補償の途中で失敗したら、補償をやり直さずに実行を失敗させる（compensable の目印）", async () => {
  const ex = await runCancel("t4", { failCompensation: "open_viewing_page" });
  assert.equal(ex.getStatus(), "FAILED");
  // 中止連絡は 1 回だけ。視聴ページは閉じられないまま、解放にも進まない（人手で引き取る）
  assert.equal(callCount("t4", "notify_cancellation"), 1);
  assert.equal(callCount("t4", "release_streaming"), 0);
  // 中止表示は残っている
  assert.equal(stateValue("t4", "sales"), "stopped_cancelled");
});

test("実験3 対照: 目印を無視すると、中止が『準備の失敗』扱いになって補償をやり直し、中止表示が消える", async () => {
  const ex = await runCancel("t5", { failCompensation: "open_viewing_page", disableCompensableGuard: true });
  // catch で準備の失敗と同じ処理に入り、販売停止（中止表示なし）で上書きしてしまう
  assert.equal(stateValue("t5", "sales"), "stopped");
  // 補償を最初から回し直すので、中止連絡の step がもう一度実行される（同じところで失敗して、結局は実行が失敗する）
  const notifyOps = ex.getOperations().filter((o) => o.getName() === "compensate_notify_partners");
  assert.equal(notifyOps.length, 2);
  assert.equal(ex.getStatus(), "FAILED");
  // 二重連絡にならずに済んでいるのは、中止連絡の冪等キーのおかげ（目印と冪等キーは守っているものが違う）
  assert.equal(callCount("t5", "notify_cancellation"), 1);
});
