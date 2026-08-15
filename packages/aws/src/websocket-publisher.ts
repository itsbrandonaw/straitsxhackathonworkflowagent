import {
  ApiGatewayManagementApiClient,
  GoneException,
  PostToConnectionCommand
} from "@aws-sdk/client-apigatewaymanagementapi";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { ActivityEvent } from "@happy/contracts";
import type { EventPublisher } from "@happy/runtime";

export class DynamoWebSocketPublisher implements EventPublisher {
  private readonly api: ApiGatewayManagementApiClient;
  private readonly document: DynamoDBDocumentClient;

  constructor(private readonly options: { tableName: string; endpoint: string; region?: string }) {
    this.api = new ApiGatewayManagementApiClient({
      endpoint: options.endpoint,
      ...(options.region ? { region: options.region } : {})
    });
    this.document = DynamoDBDocumentClient.from(new DynamoDBClient(options.region ? { region: options.region } : {}));
  }

  async publish(event: ActivityEvent): Promise<void> {
    const result = await this.document.send(new QueryCommand({
      TableName: this.options.tableName,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: { ":pk": `ACTIVITY#${event.activityId}`, ":prefix": "CONNECTION#" }
    }));
    await Promise.all((result.Items ?? []).map(async (item) => {
      const connectionId = item.connectionId as string;
      try {
        await this.api.send(new PostToConnectionCommand({
          ConnectionId: connectionId,
          Data: new TextEncoder().encode(JSON.stringify(event))
        }));
      } catch (error) {
        if (!(error instanceof GoneException)) throw error;
        await this.document.send(new DeleteCommand({
          TableName: this.options.tableName,
          Key: { PK: `ACTIVITY#${event.activityId}`, SK: `CONNECTION#${connectionId}` }
        }));
      }
    }));
  }
}
