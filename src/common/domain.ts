/**
 * ドメインモデル（durable 版 / Step Functions 版で共有）。
 *
 * 題材: 架空の野外フェス「Hokkai Sound Fes」（2 日間）の有料ライブ配信。
 * durable の実行は開演当日の朝に公演日ごとに起動し、当日の準備（1〜3）を済ませてから開演まで開催可否の判断を待つ（4）。
 * 待っている間に会場周辺の落雷・激しい雨で主催者が中止を決めると、その判断がコールバックで実行に届き、補償に入る。
 */

/** SAGA 1 ステップの定義（記事の対応表に対応）。 */
export type SagaStepName =
  | "reserve_streaming" // 1. 配信リソース確保     (補償: 配信リソースを解放)
  | "open_viewing_page" // 2. 購入者向けの視聴ページを公開 (補償: 視聴ページを閉じる)
  | "notify_partners" // 3. 外部配信先へ連絡      (補償: 中止連絡)
  | "await_go_decision" // 4. 開催可否の判断待ち    (補償なし。コールバック or 開演時刻)
  | "start_streaming"; // 5. 配信開始             (以降は戻さない = ピボット)

/** 補償スタックの 1 エントリ。原典 Saga の「終了時に補償を登録」に対応。 */
export interface CompensationEntry {
  step: SagaStepName;
  /** 人間可読の補償名（コンソール/ログ用） */
  label: string;
  /** 補償実行に必要なパラメータ（原典の「補償とパラメータを登録」） */
  params: Record<string, unknown>;
}

/** 失敗注入の指定。検証シナリオで決定論的に壊すために使う。 */
export interface FaultInjection {
  /** このステップの step 本体を失敗させる */
  failStep?: SagaStepName;
  /**
   * 冪等ガードを無効化する（対照実験用）。true のとき中止連絡は冪等キーを確かめずに送る。
   * crashAfterCompensationSideEffect と併用すると、再開時に中止連絡が二重に飛ぶことを
   * 見せられる（＝冪等キーが無いと何が壊れるか）。本番では決して true にしない。
   */
  disableIdempotency?: boolean;
  /**
   * 補償の実験 1（実機）: 指定ステップの補償が終わった直後（step の外）で、1 回だけ invocation を落とす。
   * 再開した invocation ではハンドラが先頭から実行し直され、補償スタック（ただの配列）が組み立て直される。
   * 完了済みの補償はリプレイで保存結果が使われ、本体は再実行されない。
   */
  crashBetweenCompensations?: SagaStepName;
  /**
   * 補償の実験 2（実機）: 指定ステップの補償の副作用を書いた直後・step が結果を記録する前に、1 回だけ
   * invocation を落とす。step は既定で at-least-once なので、再開後に補償の本体がもう一度走る。
   * 中止連絡（notify_partners）なら、冪等キーがあれば二重連絡にならず、disableIdempotency だと二重になる。
   */
  crashAfterCompensationSideEffect?: SagaStepName;
  /**
   * 補償の実験 2 のローカル版: 指定ステップの補償の副作用を書いたあと、1 回目の試行だけ例外を投げる
   * （「送れたのに失敗に見えた」）。step のリトライで本体がもう一度走るので、クラッシュと同じく再実行を観測できる。
   */
  failAfterCompensationSideEffect?: SagaStepName;
  /** 補償の実験 3: 指定ステップの補償を毎回失敗させる（リトライを使い切って補償が失敗する） */
  failCompensation?: SagaStepName;
  /**
   * 補償の実験 3 の対照: compensable の目印を無視する。補償中の失敗で catch に入ったときに、準備の失敗と
   * 同じ扱い（販売停止と補償のやり直し）をしてしまう。本番では決して true にしない。
   */
  disableCompensableGuard?: boolean;
}

/** SAGA 起動入力。 */
export interface SagaInput {
  eventId: string;
  eventName: string;
  /** 主催者が中止を発動するか（true なら await_go_decision で cancel コールバック） */
  cancel: boolean;
  /** 失敗注入 */
  fault?: FaultInjection;
  /** 開演時刻までの待ち（秒）。既定は中止なら 3600、開催なら 5。ローカルテストで短くするための入力 */
  showtimeSeconds?: number;
}

/** SAGA 全体の最終結果。 */
export interface SagaResult {
  eventId: string;
  outcome: "streamed" | "cancelled_and_compensated" | "rolled_back_for_review";
  completedSteps: SagaStepName[];
  compensatedSteps: SagaStepName[];
  notes: string[];
}
