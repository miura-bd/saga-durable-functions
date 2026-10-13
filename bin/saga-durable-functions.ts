#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { SagaDurableFunctionsStack } from "../lib/saga-durable-functions-stack.js";

const app = new cdk.App();
new SagaDurableFunctionsStack(app, "SagaDurableFunctionsStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    // CDK CLI は CDK_DEFAULT_REGION を常にセットする（プロファイルか AWS_REGION から決まる）ので、
    // ここに既定値を書いても効かない。検証は ap-northeast-1 なので、先に AWS_REGION を export しておく。
    region: process.env.CDK_DEFAULT_REGION,
  },
});
