import { describe, expect, it } from "vitest";
import { buildApp, createLocalDependencies } from "../apps/api/src/app.js";
import {
  LiveViewCapabilities,
  WebsiteCallbackBridge
} from "../apps/api/src/website-bridge.js";

const searchBody = {
  activityId: "website-contract-run",
  items: [{
    id: "usb-c-cable",
    name: "Braided USB-C cable",
    short: "CABLE",
    spec: "USB-C to USB-C · 100W · 2m",
    budget: "up to S$120",
    hueIndex: 0,
    category: "Electronics"
  }],
  clarifications: [{ itemId: "usb-c-cable", prompt: "Colour", chosen: "black" }],
  callback: { url: "https://website.example/callback", token: "callback-secret" },
  scouts: {
    perItem: 2,
    maxConcurrentItems: 5,
    listingsPerScout: 3,
    strategies: ["large-marketplaces", "specialist-independent"]
  }
} as const;

describe("website Scout bridge", () => {
  it("accepts the RemoteAgentProvider contract and emits ordered authenticated callbacks", async () => {
    const dependencies = createLocalDependencies();
    const calls: Array<{ body: string; authorization?: string }> = [];
    let failFirst = true;
    const callbackFetch: typeof fetch = async (_input, init) => {
      calls.push({
        body: String(init?.body),
        ...(new Headers(init?.headers).get("authorization")
          ? { authorization: new Headers(init?.headers).get("authorization")! }
          : {})
      });
      if (failFirst) {
        failFirst = false;
        return new Response(null, { status: 503 });
      }
      return new Response(null, { status: 204 });
    };
    const capabilities = new LiveViewCapabilities(
      dependencies.coordinator,
      "https://scouts.example"
    );
    const website = new WebsiteCallbackBridge(
      dependencies.coordinator,
      dependencies.events,
      capabilities,
      { fetch: callbackFetch, retryDelaysMs: [0, 0] }
    );
    const app = await buildApp({ ...dependencies, website });

    const response = await app.inject({ method: "POST", url: "/v1/runs/search", payload: searchBody });
    expect(response.statusCode).toBe(202);
    await dependencies.coordinator.waitForIdle(searchBody.activityId);
    await website.waitForIdle(searchBody.activityId);

    expect(calls[0]?.body).toBe(calls[1]?.body);
    expect(calls.every((call) => call.authorization === "Bearer callback-secret")).toBe(true);
    const callbacks = calls.slice(1).map((call) => JSON.parse(call.body) as Record<string, unknown>);
    const progress = callbacks
      .filter((callback) => callback.type === "item.progress")
      .map((callback) => callback.progress as { stage: number; previousStage: number; queued: boolean });
    expect(progress.at(0)).toEqual({ itemId: "usb-c-cable", stage: 0, previousStage: 0, queued: true });
    for (let index = 1; index < progress.length; index += 1) {
      expect(progress[index]!.previousStage).toBe(progress[index - 1]!.stage);
      expect(progress[index]).not.toEqual(progress[index - 1]);
    }
    expect(progress.some((entry, index) => entry.stage === 0 && progress[index - 1]?.stage === 2)).toBe(true);
    expect(progress.slice(-2).map((entry) => entry.stage)).toEqual([3, 4]);

    const shortlist = callbacks.find((callback) => callback.type === "shortlist.ready") as {
      shortlist: Array<{ itemId: string; listing: { amountMinor: number; url: string } }>;
    };
    expect(shortlist.shortlist).toHaveLength(1);
    expect(shortlist.shortlist[0]?.itemId).toBe("usb-c-cable");
    expect(Number.isInteger(shortlist.shortlist[0]?.listing.amountMinor)).toBe(true);
    expect(shortlist.shortlist[0]?.listing.url).toMatch(/^https:\/\//);
    await app.close();
  });

  it("keeps viewer URLs stable, refreshes signed connections, and revokes capabilities", async () => {
    let exchanges = 0;
    const coordinator = {
      liveViewUrl: async () => ({
        url: `wss://agentcore.example/live?refresh=${++exchanges}`,
        expiresAt: new Date(Date.now() + 300_000).toISOString()
      })
    } as never;
    const capabilities = new LiveViewCapabilities(coordinator, "https://scouts.example/");
    const first = capabilities.issue("activity-1", "scout-item-a");
    expect(capabilities.issue("activity-1", "scout-item-a")).toBe(first);
    const token = new URL(first).hash.slice(1);
    expect((await capabilities.exchange(token)).url).toContain("refresh=1");
    expect((await capabilities.exchange(token)).url).toContain("refresh=2");
    capabilities.revokeScout("scout-item-a");
    await expect(capabilities.exchange(token)).rejects.toThrow("missing or expired");
  });
});
