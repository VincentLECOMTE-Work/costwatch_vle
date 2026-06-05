import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applySavingsPlansCoverage } from "../sp-allocation.js";

describe("applySavingsPlansCoverage", () => {
  it("allocates commitment by highest uncovered hourly need", () => {
    const items = [
      { instanceId: "i-a", onDemandHourly: 0.4, hoursPerDay: 24, riCovered: false, instanceType: "m6i.large", region: "eu-west-3" },
      { instanceId: "i-b", onDemandHourly: 0.2, hoursPerDay: 24, riCovered: false, instanceType: "m6i.large", region: "eu-west-3" }
    ];
    const plans = [{ state: "active", type: "Compute", commitment: 0.3, region: "Any" }];

    const summary = applySavingsPlansCoverage(items, plans);

    assert.equal(summary.plans, 1);
    assert.equal(Number(summary.usedCommitment.toFixed(4)), 0.3);
    assert.equal(Number(items[0].spCoveragePct.toFixed(2)), 75);
    assert.equal(Number(items[1].spCoveragePct.toFixed(2)), 0);
  });

  it("honors EC2 instance plan scope (region + family)", () => {
    const items = [
      { instanceId: "i-a", onDemandHourly: 0.5, hoursPerDay: 24, riCovered: false, instanceType: "m6i.large", region: "eu-west-3" },
      { instanceId: "i-b", onDemandHourly: 0.5, hoursPerDay: 24, riCovered: false, instanceType: "c7g.large", region: "eu-west-3" },
      { instanceId: "i-c", onDemandHourly: 0.5, hoursPerDay: 24, riCovered: false, instanceType: "m6i.large", region: "us-east-1" }
    ];
    const plans = [{
      state: "active",
      type: "EC2_INSTANCE",
      commitment: 0.5,
      region: "eu-west-3",
      instanceFamily: "m6i"
    }];

    applySavingsPlansCoverage(items, plans);

    assert.equal(Number(items[0].spCoveragePct.toFixed(2)), 100);
    assert.equal(Number(items[1].spCoveragePct.toFixed(2)), 0);
    assert.equal(Number(items[2].spCoveragePct.toFixed(2)), 0);
  });

  it("recognizes EC2Instance type format from AWS inventory payload", () => {
    const items = [
      { instanceId: "i-a", onDemandHourly: 0.5, hoursPerDay: 24, riCovered: false, instanceType: "r8i.xlarge", region: "eu-west-3" },
      { instanceId: "i-b", onDemandHourly: 0.5, hoursPerDay: 24, riCovered: false, instanceType: "m7i.xlarge", region: "eu-west-3" }
    ];
    const plans = [{
      state: "active",
      type: "EC2Instance",
      commitment: 0.5,
      region: "eu-west-3",
      instanceFamily: "r8i"
    }];

    applySavingsPlansCoverage(items, plans);

    assert.equal(Number(items[0].spCoveragePct.toFixed(2)), 100);
    assert.equal(Number(items[1].spCoveragePct.toFixed(2)), 0);
  });

  it("uses scheduled daily hours to compute commitment need", () => {
    const items = [
      { instanceId: "i-a", onDemandHourly: 0.24, hoursPerDay: 12, riCovered: false, instanceType: "m6i.large", region: "eu-west-3" }
    ];
    const plans = [{ state: "active", type: "Compute", commitment: 0.12, region: "Any" }];

    applySavingsPlansCoverage(items, plans);

    assert.equal(Number(items[0].spEligibleHourly.toFixed(4)), 0.12);
    assert.equal(Number(items[0].spCoveragePct.toFixed(2)), 100);
  });

  it("does not apply SP coverage to RI-covered items", () => {
    const items = [
      { instanceId: "i-a", onDemandHourly: 0.3, hoursPerDay: 24, riCovered: true, instanceType: "m6i.large", region: "eu-west-3" }
    ];
    const plans = [{ state: "active", type: "Compute", commitment: 0.3, region: "Any" }];

    const summary = applySavingsPlansCoverage(items, plans);

    assert.equal(Number(items[0].spCoveragePct.toFixed(2)), 0);
    assert.equal(summary.appliedInstances, 0);
    assert.equal(Number(summary.usedCommitment.toFixed(2)), 0);
  });

  it("supports plan-specific discounted rate resolution", () => {
    const items = [
      { instanceId: "i-a", onDemandHourly: 0.5, hoursPerDay: 24, riCovered: false, instanceType: "r8i.xlarge", region: "eu-west-3" }
    ];
    const plans = [
      { state: "active", type: "EC2Instance", commitment: 0.3, region: "eu-west-3", instanceFamily: "r8i" }
    ];

    const summary = applySavingsPlansCoverage(items, plans, {
      resolvePlanHourlyRate() {
        return 0.14753;
      }
    });

    assert.equal(Number(summary.usedCommitment.toFixed(5)), 0.14753);
    assert.equal(Number(summary.unusedCommitment.toFixed(5)), 0.15247);
    assert.equal(Number(items[0].spCoveragePct.toFixed(2)), 100);
  });
});
