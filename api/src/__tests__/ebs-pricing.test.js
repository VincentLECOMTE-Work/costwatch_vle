import test from "node:test";
import assert from "node:assert/strict";
import { estimateEbsVolumeMonthlyCost } from "../ebs-pricing.js";

const pricing = {
  "eu-west-3": {
    source: "test",
    rates: {
      gp3: { storageGbMonth: 0.0928, iopsMonth: 0.0058, throughputMiBpsMonth: 0.0464 },
      io2: {
        storageGbMonth: 0.145,
        iopsTiers: [
          { upTo: 32000, rate: 0.076 },
          { upTo: 64000, rate: 0.0532 },
          { upTo: null, rate: 0.0372 }
        ]
      }
    }
  }
};

test("gp3 default performance only charges provisioned storage", () => {
  const estimate = estimateEbsVolumeMonthlyCost({
    region: "eu-west-3",
    type: "gp3",
    sizeGiB: 8,
    iops: 3000,
    throughput: 125
  }, pricing);

  assert.equal(estimate.monthly, 0.7424);
  assert.equal(estimate.components.iopsMonthly, 0);
  assert.equal(estimate.components.throughputMonthly, 0);
});

test("gp3 charges IOPS and throughput above the included baseline", () => {
  const estimate = estimateEbsVolumeMonthlyCost({
    region: "eu-west-3",
    type: "gp3",
    sizeGiB: 100,
    iops: 4000,
    throughput: 250
  }, pricing);

  assert.equal(estimate.monthly, 20.88);
  assert.equal(estimate.components.iopsBillable, 1000);
  assert.equal(estimate.components.throughputBillable, 125);
});

test("io2 uses tiered provisioned IOPS pricing", () => {
  const estimate = estimateEbsVolumeMonthlyCost({
    region: "eu-west-3",
    type: "io2",
    sizeGiB: 100,
    iops: 70000
  }, pricing);

  assert.equal(estimate.monthly, 4372.1);
});
