import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeAutoIngestWindow } from "../ingest-window.js";

describe("computeAutoIngestWindow", () => {
  it("uses last complete imported day minus overlap", () => {
    const plan = computeAutoIngestWindow({
      today: new Date("2025-12-18T14:20:00Z"),
      lagDays: 2,
      overlapDays: 1,
      bootstrapDays: 30,
      metricMaxDays: {
        UnblendedCost: "2025-12-10",
        AmortizedCost: "2025-12-10"
      }
    });

    assert.equal(plan.mode, "resume");
    assert.equal(plan.toInclusive, "2025-12-16");
    assert.equal(plan.fromInclusive, "2025-12-09");
    assert.equal(plan.toExclusive, "2025-12-17");
    assert.equal(plan.shouldIngest, true);
  });

  it("falls back to bootstrap when no data exists", () => {
    const plan = computeAutoIngestWindow({
      today: new Date("2025-12-18T00:00:00Z"),
      lagDays: 2,
      overlapDays: 1,
      bootstrapDays: 30,
      metricMaxDays: {
        UnblendedCost: null,
        AmortizedCost: null
      }
    });

    assert.equal(plan.mode, "bootstrap");
    assert.equal(plan.toInclusive, "2025-12-16");
    assert.equal(plan.baselineLastDay, "2025-11-16");
    assert.equal(plan.fromInclusive, "2025-11-15");
  });

  it("marks a no-op window when last imported day is already after target", () => {
    const plan = computeAutoIngestWindow({
      today: new Date("2025-12-18T00:00:00Z"),
      lagDays: 2,
      overlapDays: 1,
      bootstrapDays: 30,
      metricMaxDays: {
        UnblendedCost: "2025-12-20"
      }
    });

    assert.equal(plan.toInclusive, "2025-12-16");
    assert.equal(plan.fromInclusive, "2025-12-19");
    assert.equal(plan.shouldIngest, false);
  });
});
