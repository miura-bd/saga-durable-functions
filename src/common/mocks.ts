/**
 * 共通モック（ビジネスロジック）。durable 版と Step Functions 版が同じこのロジックを共有する。
 * ただし呼び出し方は違う: durable 版はこのモジュールを同一プロセス内で直接 import して呼び、
 * SF 版はこれをワーカー Lambda（worker/handler.ts）として切り出し、各ステートから invoke する。
 * 共有するのはビジネスロジックで、実行トポロジは同一ではない。
 * 副作用は DynamoDB の state 行と呼び出し回数カウンタ（calls#<name>）で観測できるようにしてある。
 */
import {
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const IDEMPOTENCY = process.env.IDEMPOTENCY_TABLE!;

// ---- 配信リソース / 自社販売 / 外部配信先のモック（副作用は DynamoDB の state 行で可視化） ----

const STATE = process.env.STATE_TABLE!;

async function putState(eventId: string, key: string, value: unknown): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: STATE,
      Item: { eventId, stateKey: key, value, at: new Date().toISOString() },
    }),
  );
}

/**
 * 副作用が実際に走った回数を数える（state テーブルの calls#<name> 行）。
 * 補償の step 本体が再実行されたかどうかを観測するため。
 */
async function countCall(eventId: string, name: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: STATE,
      Key: { eventId, stateKey: `calls#${name}` },
      UpdateExpression: "ADD #n :one",
      ExpressionAttributeNames: { "#n": "n" },
      ExpressionAttributeValues: { ":one": 1 },
    }),
  );
}

/**
 * 観測用のフック。既定では CloudWatch Logs に 1 行の JSON を出す（実機では invocation ごとのログで、
 * 補償スタックがリプレイで組み立て直されたことを確かめる）。ローカルテストでは差し替えて集める。
 */
export const trace = {
  emit(type: string, data: Record<string, unknown>): void {
    console.log(JSON.stringify({ type, ...data }));
  },
};

export const resources = {
  async reserve(eventId: string): Promise<void> {
    await countCall(eventId, "reserve_streaming");
    await putState(eventId, "streaming", "reserved");
  },
  /** 補償: 状態の上書きなので、2 回走っても結果は同じ（冪等な書き込み） */
  async release(eventId: string): Promise<void> {
    await countCall(eventId, "release_streaming");
    await putState(eventId, "streaming", "released");
  },
  async start(eventId: string): Promise<void> {
    await putState(eventId, "streaming", "live");
  },
};

/** 配信チケットの販売（前の週から受付中。当日の SAGA では止めるだけ） */
export const sales = {
  async stopAndShowCancelled(eventId: string): Promise<void> {
    await putState(eventId, "sales", "stopped_cancelled");
  },
  /** 当日の準備の失敗時: 販売だけを止める。中止表示にはしない（中止かどうかは人が判断する）。 */
  async stop(eventId: string): Promise<void> {
    await putState(eventId, "sales", "stopped");
  },
};

/** 購入者向けの視聴ページ（当日の朝に公開する） */
export const viewingPage = {
  async open(eventId: string): Promise<void> {
    await countCall(eventId, "open_viewing_page");
    await putState(eventId, "viewing", "open");
  },
  /** 補償: 状態の上書きなので、2 回走っても結果は同じ（冪等な書き込み） */
  async close(eventId: string): Promise<void> {
    await countCall(eventId, "close_viewing_page");
    await putState(eventId, "viewing", "closed");
  },
};

export const partners = {
  /** 外部配信先へ配信情報を連絡（補償: 中止連絡） */
  async notifyStreamInfo(eventId: string): Promise<void> {
    await countCall(eventId, "notify_partners");
    await putState(eventId, "partner", "stream_info_sent");
  },
  /**
   * 補償: 外部配信先への中止連絡。外へ 1 回だけ送りたい副作用なので、冪等キー
   * （`<eventId>#cancellation`）を確かめてから送る。送れた回数は calls#notify_cancellation で数える。
   * disableIdempotency（対照実験用）のときはキーを見ずに送るので、step 本体の再実行で二重連絡になる。
   * 「読む → 送る → 書く」の簡略実装。本番では条件付き書き込みで先にキーを押さえるか、相手の API の冪等キーに任せる
   * （docs/production-notes.md）。
   */
  async notifyCancellation(eventId: string, opts?: { disableIdempotency?: boolean }): Promise<void> {
    const idemKey = `${eventId}#cancellation`;
    if (!opts?.disableIdempotency) {
      const existing = await ddb.send(new GetCommand({ TableName: IDEMPOTENCY, Key: { idemKey } }));
      if (existing.Item) return; // 送信済み（冪等ヒット）。もう一度は送らない
    }
    await countCall(eventId, "notify_cancellation"); // ここで外部へ送った、とみなす
    await putState(eventId, "partner", "cancellation_sent");
    await ddb.send(
      new PutCommand({ TableName: IDEMPOTENCY, Item: { idemKey, status: "sent", at: new Date().toISOString() } }),
    );
  },
};

export { ddb, STATE, IDEMPOTENCY };
