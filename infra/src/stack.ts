import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_apigatewayv2 as apigatewayv2,
  aws_apigatewayv2_integrations as integrations,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_s3 as s3
} from "aws-cdk-lib";
import type { Construct } from "constructs";

export class HappyScoutsStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const table = new dynamodb.Table(this, "StateTable", {
      tableName: "happy-scouts-state",
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: "expiresAt",
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: RemovalPolicy.RETAIN
    });

    const screenshots = new s3.Bucket(this, "ScreenshotBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{ expiration: Duration.days(1), prefix: "snapshots/" }],
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true
    });

    const connectionHandler = new lambda.Function(this, "WebSocketConnectionHandler", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      timeout: Duration.seconds(10),
      environment: { TABLE_NAME: table.tableName },
      code: lambda.Code.fromInline(`
        const { DynamoDBClient, TransactWriteItemsCommand, GetItemCommand } = require("@aws-sdk/client-dynamodb");
        const client = new DynamoDBClient({});
        exports.handler = async (event) => {
          const route = event.requestContext.routeKey;
          const connectionId = event.requestContext.connectionId;
          if (route === "$connect") {
            const activityId = event.queryStringParameters && event.queryStringParameters.activityId;
            if (!activityId) return { statusCode: 400, body: "activityId is required" };
            const expiresAt = String(Math.floor(Date.now() / 1000) + 86400);
            await client.send(new TransactWriteItemsCommand({ TransactItems: [
              { Put: { TableName: process.env.TABLE_NAME, Item: {
                PK: { S: "ACTIVITY#" + activityId }, SK: { S: "CONNECTION#" + connectionId },
                connectionId: { S: connectionId }, expiresAt: { N: expiresAt }
              } } },
              { Put: { TableName: process.env.TABLE_NAME, Item: {
                PK: { S: "CONNECTION#" + connectionId }, SK: { S: "LOOKUP" },
                activityId: { S: activityId }, expiresAt: { N: expiresAt }
              } } }
            ] }));
          } else if (route === "$disconnect") {
            const lookup = await client.send(new GetItemCommand({
              TableName: process.env.TABLE_NAME,
              Key: { PK: { S: "CONNECTION#" + connectionId }, SK: { S: "LOOKUP" } }
            }));
            const activityId = lookup.Item && lookup.Item.activityId && lookup.Item.activityId.S;
            if (activityId) await client.send(new TransactWriteItemsCommand({ TransactItems: [
              { Delete: { TableName: process.env.TABLE_NAME, Key: {
                PK: { S: "ACTIVITY#" + activityId }, SK: { S: "CONNECTION#" + connectionId }
              } } },
              { Delete: { TableName: process.env.TABLE_NAME, Key: {
                PK: { S: "CONNECTION#" + connectionId }, SK: { S: "LOOKUP" }
              } } }
            ] }));
          }
          return { statusCode: 200, body: "ok" };
        };
      `)
    });
    table.grantReadWriteData(connectionHandler);
    const websocketIntegration = new integrations.WebSocketLambdaIntegration(
      "ConnectionIntegration",
      connectionHandler
    );
    const websocket = new apigatewayv2.WebSocketApi(this, "EventsWebSocket", {
      apiName: "happy-scouts-events",
      connectRouteOptions: { integration: websocketIntegration },
      disconnectRouteOptions: { integration: websocketIntegration },
      defaultRouteOptions: { integration: websocketIntegration }
    });
    const websocketStage = new apigatewayv2.WebSocketStage(this, "EventsWebSocketStage", {
      webSocketApi: websocket,
      stageName: "prod",
      autoDeploy: true
    });

    const runtimeRole = new iam.Role(this, "AgentCoreRuntimeRole", {
      assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com")
    });
    table.grantReadWriteData(runtimeRole);
    screenshots.grantReadWrite(runtimeRole);
    runtimeRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream",
        "bedrock-agentcore:StartBrowserSession",
        "bedrock-agentcore:GetBrowserSession",
        "bedrock-agentcore:StopBrowserSession",
        "bedrock-agentcore:ConnectBrowserAutomationStream",
        "bedrock-agentcore:ConnectBrowserLiveViewStream"
      ],
      resources: ["*"]
    }));
    runtimeRole.addToPolicy(new iam.PolicyStatement({
      actions: ["execute-api:ManageConnections"],
      resources: [`arn:${this.partition}:execute-api:${this.region}:${this.account}:${websocket.apiId}/*`]
    }));

    new CfnOutput(this, "StateTableName", { value: table.tableName });
    new CfnOutput(this, "ScreenshotBucketName", { value: screenshots.bucketName });
    new CfnOutput(this, "WebSocketApiId", { value: websocket.apiId });
    new CfnOutput(this, "WebSocketUrl", { value: websocketStage.url });
    new CfnOutput(this, "WebSocketManagementEndpoint", {
      value: `https://${websocket.apiId}.execute-api.${this.region}.${this.urlSuffix}/${websocketStage.stageName}`
    });
    new CfnOutput(this, "AgentCoreRuntimeRoleArn", { value: runtimeRole.roleArn });
  }
}
