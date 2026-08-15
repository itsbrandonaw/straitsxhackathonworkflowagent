import type { LiveViewProvider } from "@happy/runtime";
import type { ScoutRecord } from "@happy/contracts";

export class LocalLiveViewProvider implements LiveViewProvider {
  constructor(private readonly publicApiUrl: string) {}

  async createUrl(scout: ScoutRecord): Promise<{ url: string; expiresAt: string }> {
    return {
      url: new URL(`/v1/scouts/${encodeURIComponent(scout.id)}/live`, this.publicApiUrl).toString(),
      expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1_000).toISOString()
    };
  }
}
