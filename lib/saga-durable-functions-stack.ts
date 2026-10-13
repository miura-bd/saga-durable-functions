import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  CfnOutput,
} from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";
import { buildStateMachine } from "./sfn-saga.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "..", "src");

export class SagaDurableFunctionsStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // ---- DynamoDB: SAGA 状態 / 冪等キー ----
    const stateTable = new dynamodb.Table(this, "SagaState", {
      partitionKey: { name: "eventId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "stateKey", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const idempotency = new dynamodb.Table(this, "Idempotency", {
      partitionKey: { name: "idemKey", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const commonEnv = {
      STATE_TABLE: stateTable.tableName,
      IDEMPOTENCY_TABLE: idempotency.tableName,
    };

    const bundling = {
      format: OutputFormat.ESM,
      target: "node22",
      // durable SDK はランタイムにも入っているが、デプロイパッケージに同梱して lockfile でバージョンを固定する
      // （ランタイム側の SDK が更新されても、このサンプルの挙動が変わらないように）。
      mainFields: ["module", "main"],
    };

    // ---- ワーカー Lambda（SF 版が使う通常関数） ----
    const worker = new NodejsFunction(this, "Worker", {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(SRC, "worker", "handler.ts"),
      handler: "handler",
      timeout: Duration.seconds(30),
      memorySize: 256,
      environment: commonEnv,
      // ロググループもスタックで管理し、cdk destroy で一緒に消えるようにする
      logGroup: new logs.LogGroup(this, "WorkerLogs", {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      bundling,
    });
    stateTable.grantReadWriteData(worker);
    idempotency.grantReadWriteData(worker);

    // ---- durable functions 版オーケストレータ ----
    const durable = new NodejsFunction(this, "DurableSaga", {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(SRC, "durable", "orchestrator.ts"),
      handler: "handler",
      timeout: Duration.minutes(15), // 1 invocation の上限
      memorySize: 256,
      environment: commonEnv,
      logGroup: new logs.LogGroup(this, "DurableSagaLogs", {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      bundling,
      // durable 実行を有効化（execution timeout と履歴保持）
      // 開演当日の朝に起動して、開演（配信開始）まで待つ想定なので 12 時間
      durableConfig: {
        executionTimeout: Duration.hours(12),
        retentionPeriod: Duration.days(7),
      },
    });
    stateTable.grantReadWriteData(durable);
    idempotency.grantReadWriteData(durable);

    // ---- Step Functions 版（同じ worker Lambda を呼ぶ） ----
    const stateMachine = buildStateMachine(this, worker);

    new CfnOutput(this, "WorkerFunctionName", { value: worker.functionName });
    new CfnOutput(this, "DurableFunctionName", { value: durable.functionName });
    new CfnOutput(this, "DurableFunctionArn", { value: durable.functionArn });
    new CfnOutput(this, "StateMachineArn", { value: stateMachine.stateMachineArn });
    new CfnOutput(this, "StateTable", { value: stateTable.tableName });
    new CfnOutput(this, "IdempotencyTable", { value: idempotency.tableName });
  }
}
