import { Sha256 } from "@aws-crypto/sha256-js";
import {
  BedrockAgentCoreClient,
  StartBrowserSessionCommand,
  StopBrowserSessionCommand
} from "@aws-sdk/client-bedrock-agentcore";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { formatUrl } from "@aws-sdk/util-format-url";
import type { ScoutRecord } from "@happy/contracts";
import type { LiveViewProvider } from "@happy/runtime";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";

export class AgentCoreBrowserSessions implements LiveViewProvider {
  private readonly client: BedrockAgentCoreClient;
  private readonly signer: SignatureV4;

  constructor(private readonly options: { region: string; browserIdentifier: string }) {
    this.client = new BedrockAgentCoreClient({ region: options.region });
    this.signer = new SignatureV4({
      credentials: defaultProvider(),
      region: options.region,
      service: "bedrock-agentcore",
      sha256: Sha256
    });
  }

  async start(name: string): Promise<{ sessionId: string; automationUrl: string }> {
    const response = await this.client.send(new StartBrowserSessionCommand({
      browserIdentifier: this.options.browserIdentifier,
      name: name.slice(0, 100),
      sessionTimeoutSeconds: 1_200,
      viewPort: { width: 1280, height: 720 },
      clientToken: crypto.randomUUID()
    }));
    if (!response.sessionId) throw new Error("AgentCore Browser did not return a session ID");
    return {
      sessionId: response.sessionId,
      automationUrl: await this.presignStream(response.sessionId, "automation", 300)
    };
  }

  async stop(sessionId: string): Promise<void> {
    await this.client.send(new StopBrowserSessionCommand({
      browserIdentifier: this.options.browserIdentifier,
      sessionId,
      clientToken: crypto.randomUUID()
    }));
  }

  async createUrl(scout: ScoutRecord): Promise<{ url: string; expiresAt: string }> {
    if (!scout.browserSessionId) throw new Error("Scout has no active AgentCore Browser session");
    const lifetimeSeconds = 300;
    return {
      url: await this.presignStream(scout.browserSessionId, "live-view", lifetimeSeconds),
      expiresAt: new Date(Date.now() + lifetimeSeconds * 1000).toISOString()
    };
  }

  private async presignStream(sessionId: string, stream: "automation" | "live-view", expiresIn: number): Promise<string> {
    const hostname = `bedrock-agentcore.${this.options.region}.amazonaws.com`;
    const path = `/browser-streams/${encodeURIComponent(this.options.browserIdentifier)}/sessions/${encodeURIComponent(sessionId)}/${stream}`;
    const request = new HttpRequest({ protocol: "https:", hostname, method: "GET", path, headers: { host: hostname } });
    const signed = await this.signer.presign(request, { expiresIn });
    return formatUrl(signed).replace(/^https:/, "wss:");
  }
}
