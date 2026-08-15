import { App } from "aws-cdk-lib";
import { HappyScoutsStack } from "./stack.js";

const app = new App();
const account = process.env.CDK_DEFAULT_ACCOUNT;
new HappyScoutsStack(app, "HappyScoutsStack", {
  env: {
    ...(account ? { account } : {}),
    region: process.env.HAPPY_AWS_REGION ?? "ap-southeast-1"
  }
});
