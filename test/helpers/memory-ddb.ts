/**
 * テスト用のインメモリ DynamoDB（aws-sdk-client-mock で DocumentClient を差し替える最小実装）。
 * 本物の DynamoDB と違い、予約語（status など）を別名なしで使っても素通しする点に注意。
 */
import { mockClient } from "aws-sdk-client-mock";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

process.env.STATE_TABLE = "SagaState";
process.env.IDEMPOTENCY_TABLE = "Idempotency";

export type Row = Record<string, unknown>;
export const tables: Record<string, Map<string, Row>> = {};

const keyOf = (t: string, item: Row) =>
  t === "Idempotency" ? String(item.idemKey) : `${item.eventId}#${item.stateKey}`;

const ddbMock = mockClient(DynamoDBDocumentClient);

/** テーブルを空にしてモックを張り直す。各テストの beforeEach で呼ぶ。 */
export function resetMemoryDdb(): void {
  tables.SagaState = new Map();
  tables.Idempotency = new Map();
  ddbMock.reset();

  ddbMock.on(PutCommand).callsFake((input) => {
    const t = input.TableName as string;
    const item = input.Item as Row;
    // 条件付き書き込み（attribute_not_exists）対応: 既存なら失敗させる
    if (input.ConditionExpression?.includes("attribute_not_exists")) {
      if (tables[t].has(keyOf(t, item))) {
        const err = new Error("conditional check failed");
        (err as { name?: string }).name = "ConditionalCheckFailedException";
        throw err;
      }
    }
    tables[t].set(keyOf(t, item), { ...item });
    return {};
  });

  ddbMock.on(GetCommand).callsFake((input) => {
    const t = input.TableName as string;
    return { Item: tables[t].get(keyOf(t, input.Key as Row)) };
  });

  ddbMock.on(UpdateCommand).callsFake((input) => {
    const t = input.TableName as string;
    const key = input.Key as Row;
    const k = keyOf(t, key);
    const cur = tables[t].get(k) ?? { ...key };
    const vals = (input.ExpressionAttributeValues ?? {}) as Row;
    const names = (input.ExpressionAttributeNames ?? {}) as Record<string, string>;
    const expr = String(input.UpdateExpression ?? "");
    // SET #a = :a, ...
    const setMatch = expr.match(/SET (.+?)(?: ADD |$)/);
    if (setMatch) {
      for (const assign of setMatch[1].split(",")) {
        const [lhs, rhs] = assign.split("=").map((s) => s.trim());
        cur[names[lhs] ?? lhs] = vals[rhs];
      }
    }
    // ADD #n :one（数値加算。呼び出し回数のカウンタ）
    const addMatch = expr.match(/ADD (#?\w+) (:\w+)/);
    if (addMatch) {
      const [, lhs, token] = addMatch;
      const attr = names[lhs] ?? lhs;
      cur[attr] = ((cur[attr] as number) ?? 0) + (vals[token] as number);
    }
    tables[t].set(k, cur);
    return {};
  });
}

/** state テーブルの 1 行の value を読む（補償の副作用の確認用）。 */
export function stateValue(eventId: string, stateKey: string): unknown {
  return tables.SagaState.get(`${eventId}#${stateKey}`)?.value;
}

/** state テーブルの呼び出し回数カウンタ（calls#<name> 行の n）を読む。 */
export function callCount(eventId: string, name: string): number {
  return (tables.SagaState.get(`${eventId}#calls#${name}`)?.n as number) ?? 0;
}
