import { describe, expect, it } from "vitest";
import { StartScoutRunRequestSchema } from "@happy/contracts";

describe("StartScoutRunRequest", () => {
  it("applies product defaults", () => {
    const parsed = StartScoutRunRequestSchema.parse({
      activityId: "activity-1",
      items: [{ itemId: "item-1", name: "RAM", specs: { capacity: "16GB" } }]
    });
    expect(parsed.items[0]).toMatchObject({
      quantity: 1,
      rankingPreset: "best_overall",
      shipToCountry: "SG",
      locale: "en-SG"
    });
  });

  it("rejects duplicate item IDs", () => {
    expect(() => StartScoutRunRequestSchema.parse({
      activityId: "activity-1",
      items: [
        { itemId: "same", name: "A", specs: {} },
        { itemId: "same", name: "B", specs: {} }
      ]
    })).toThrow(/Duplicate itemId/);
  });
});
