import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";
import type { StartScoutRunRequest } from "@happy/contracts";
import type { ActivityInvoker } from "@happy/runtime";

export class AgentCoreActivityInvoker implements ActivityInvoker {
  private readonly client: BedrockAgentCoreClient;

  constructor(private readonly runtimeArn: string, options: { region?: string } = {}) {
    this.client = new BedrockAgentCoreClient(options.region ? { region: options.region } : {});
  }

  async invoke(request: StartScoutRunRequest, idempotencyKey: string): Promise<void> {
    const response = await this.client.send(new InvokeAgentRuntimeCommand({
      agentRuntimeArn: this.runtimeArn,
      runtimeSessionId: crypto.randomUUID(),
      contentType: "application/json",
      accept: "application/json",
      payload: new TextEncoder().encode(JSON.stringify({ request, idempotencyKey }))
    }));
    if (response.statusCode !== undefined && response.statusCode >= 400) {
      throw new Error(`AgentCore Runtime invocation failed with status ${response.statusCode}`);
    }
  }
}
