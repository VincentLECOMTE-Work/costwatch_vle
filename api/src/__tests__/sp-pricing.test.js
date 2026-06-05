import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveCatalogTermForPlan, resolveSavingsPlanRateForTerm } from "../sp-pricing.js";

const TERM = {
  description: "3 year No Upfront r8i EC2 Instance Savings Plan in eu-west-3",
  rates: [
    {
      discountedInstanceType: "r8i.xlarge",
      discountedRegionCode: "eu-west-3",
      discountedUsageType: "EUW3-BoxUsage:r8i.xlarge",
      discountedOperation: "RunInstances",
      discountedRate: { price: "0.14753", currency: "USD" }
    },
    {
      discountedInstanceType: "r8i.xlarge",
      discountedRegionCode: "eu-west-3",
      discountedUsageType: "EUW3-BoxUsage:r8i.xlarge",
      discountedOperation: "RunInstances:0002",
      discountedRate: { price: "0.33153", currency: "USD" }
    },
    {
      discountedInstanceType: "r8i.xlarge",
      discountedRegionCode: "eu-west-3",
      discountedUsageType: "EUW3-BoxUsage:r8i.xlarge",
      discountedOperation: "RunInstances:0002:box",
      discountedRate: { price: "0.14753", currency: "USD" }
    },
    {
      discountedInstanceType: "r8i.xlarge",
      discountedRegionCode: "eu-west-3",
      discountedUsageType: "EUW3-DedicatedUsage:r8i.xlarge",
      discountedOperation: "RunInstances:0002",
      discountedRate: { price: "0.34628", currency: "USD" }
    },
    {
      discountedInstanceType: "r8i.xlarge",
      discountedRegionCode: "eu-west-3",
      discountedUsageType: "EUW3-UnusedBox:r8i.xlarge",
      discountedOperation: "RunInstances:0002",
      discountedRate: { price: "0.01000", currency: "USD" }
    }
  ]
};

describe("resolveCatalogTermForPlan", () => {
  it("matches plan by exact description", () => {
    const catalog = {
      termsByDescription: new Map([[TERM.description.toLowerCase(), TERM]]),
      terms: [TERM]
    };
    const out = resolveCatalogTermForPlan(catalog, { description: TERM.description });
    assert.equal(out, TERM);
  });
});

describe("resolveSavingsPlanRateForTerm", () => {
  it("returns Linux shared rate from RunInstances operation", () => {
    const rate = resolveSavingsPlanRateForTerm(TERM, {
      instanceType: "r8i.xlarge",
      region: "eu-west-3",
      tenancy: "shared",
      pricingOperation: "RunInstances"
    });
    assert.equal(rate, 0.14753);
  });

  it("returns Windows shared rate from matching operation code", () => {
    const rate = resolveSavingsPlanRateForTerm(TERM, {
      instanceType: "r8i.xlarge",
      region: "eu-west-3",
      tenancy: "shared",
      pricingOperation: "RunInstances:0002"
    });
    assert.equal(rate, 0.33153);
  });

  it("applies tenancy usage class filtering", () => {
    const rate = resolveSavingsPlanRateForTerm(TERM, {
      instanceType: "r8i.xlarge",
      region: "eu-west-3",
      tenancy: "dedicated",
      pricingOperation: "RunInstances:0002"
    });
    assert.equal(rate, 0.34628);
  });

  it("returns null when no rate can be matched", () => {
    const rate = resolveSavingsPlanRateForTerm(TERM, {
      instanceType: "c7g.xlarge",
      region: "eu-west-3",
      tenancy: "shared",
      pricingOperation: "RunInstances"
    });
    assert.equal(rate, null);
  });
});
