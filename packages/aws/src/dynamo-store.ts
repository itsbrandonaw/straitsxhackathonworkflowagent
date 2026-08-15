import type { ActivityEvent, ActivityRecord } from "@happy/contracts";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand
} from "@aws-sdk/lib-dynamodb";
import type { ActivityStore, CreateActivityResult } from "@happy/runtime";

export class DynamoActivityStore implements ActivityStore {
  private readonly document: DynamoDBDocumentClient;

  constructor(private readonly tableName: string, options: { region?: string } = {}) {
    this.document = DynamoDBDocumentClient.from(new DynamoDBClient(options.region ? { region: options.region } : {}), {
      marshallOptions: { removeUndefinedValues: true }
    });
  }

  async create(activity: ActivityRecord): Promise<CreateActivityResult> {
    const existing = await this.getByIdempotencyKey(activity.idempotencyKey);
    if (existing) return { created: false, activity: existing };
    try {
      await this.document.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: { PK: `ACTIVITY#${activity.id}`, SK: "STATE", entityType: "Activity", activity },
              ConditionExpression: "attribute_not_exists(PK)"
            }
          },
          {
            Put: {
              TableName: this.tableName,
              Item: {
                PK: `IDEMPOTENCY#${activity.idempotencyKey}`,
                SK: "LOOKUP",
                entityType: "Idempotency",
                activityId: activity.id
              },
              ConditionExpression: "attribute_not_exists(PK)"
            }
          }
        ]
      }));
      return { created: true, activity: structuredClone(activity) };
    } catch (error) {
      const raced = await this.getByIdempotencyKey(activity.idempotencyKey);
      if (raced) return { created: false, activity: raced };
      throw error;
    }
  }

  async get(activityId: string): Promise<ActivityRecord | undefined> {
    const response = await this.document.send(new GetCommand({
      TableName: this.tableName,
      Key: { PK: `ACTIVITY#${activityId}`, SK: "STATE" },
      ConsistentRead: true
    }));
    return response.Item?.activity as ActivityRecord | undefined;
  }

  async save(activity: ActivityRecord, expectedVersion: number): Promise<void> {
    await this.document.send(new PutCommand({
      TableName: this.tableName,
      Item: { PK: `ACTIVITY#${activity.id}`, SK: "STATE", entityType: "Activity", activity },
      ConditionExpression: "#activity.#version = :expected",
      ExpressionAttributeNames: { "#activity": "activity", "#version": "version" },
      ExpressionAttributeValues: { ":expected": expectedVersion }
    }));
  }

  async appendEvent(event: ActivityEvent): Promise<void> {
    const sequence = event.sequence.toString().padStart(12, "0");
    await this.document.send(new PutCommand({
      TableName: this.tableName,
      Item: {
        PK: `ACTIVITY#${event.activityId}`,
        SK: `EVENT#${sequence}`,
        entityType: "Event",
        event,
        expiresAt: Math.floor(Date.now() / 1000) + 86_400
      },
      ConditionExpression: "attribute_not_exists(PK)"
    }));
  }

  async eventsAfter(activityId: string, sequence: number): Promise<ActivityEvent[]> {
    const response = await this.document.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: "PK = :pk AND SK > :after",
      ExpressionAttributeValues: {
        ":pk": `ACTIVITY#${activityId}`,
        ":after": `EVENT#${sequence.toString().padStart(12, "0")}`
      },
      ConsistentRead: true
    }));
    return (response.Items ?? []).flatMap((item) => item.event ? [item.event as ActivityEvent] : []);
  }

  private async getByIdempotencyKey(idempotencyKey: string): Promise<ActivityRecord | undefined> {
    const response = await this.document.send(new GetCommand({
      TableName: this.tableName,
      Key: { PK: `IDEMPOTENCY#${idempotencyKey}`, SK: "LOOKUP" },
      ConsistentRead: true
    }));
    const activityId = response.Item?.activityId as string | undefined;
    return activityId ? this.get(activityId) : undefined;
  }
}
