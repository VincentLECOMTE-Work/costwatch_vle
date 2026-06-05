import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { PricingClient } from "@aws-sdk/client-pricing";
import {
  deriveEffectiveHourlyRate,
  projectTimeframes,
  getEc2OnDemandPricing,
  buildRateKey,
  resetEc2PricingCache
} from "../ec2-pricing.js";

describe("deriveEffectiveHourlyRate", () => {
  it("prefers RI rate when includeReserved is true", () => {
    const hourly = deriveEffectiveHourlyRate({
      onDemandHourly: 0.24,
      riHourly: 0.1,
      includeReserved: true
    });
    assert.equal(hourly, 0.1);
  });

  it("falls back to on-demand when includeReserved is false", () => {
    const hourly = deriveEffectiveHourlyRate({
      onDemandHourly: 0.24,
      riHourly: 0.1,
      includeReserved: false
    });
    assert.equal(hourly, 0.24);
  });

  it("returns on-demand when no RI rate is available", () => {
    const hourly = deriveEffectiveHourlyRate({
      onDemandHourly: 0.5,
      riHourly: null,
      includeReserved: true
    });
    assert.equal(hourly, 0.5);
  });
});

describe("projectTimeframes", () => {
  it("projects daily, monthly and yearly costs", () => {
    const { hourly, daily, monthly, yearly } = projectTimeframes(0.5);
    assert.equal(hourly, 0.5);
    assert.equal(daily, 12); // 0.5 * 24
    assert.equal(monthly, 360); // 12 * 30
    assert.equal(yearly, 4380); // 12 * 365
  });

  it("supports overriding the number of daily hours", () => {
    const { hourly, daily, monthly, yearly } = projectTimeframes(0.25, { dailyHours: 12 });
    assert.equal(hourly, 0.25);
    assert.equal(daily, 3); // 0.25 * 12
    assert.equal(monthly, 90); // 3 * 30
    assert.equal(yearly, 1095); // 3 * 365
  });

  it("returns null projections for invalid rates", () => {
    const result = projectTimeframes(NaN);
    assert.deepEqual(result, {
      hourly: null,
      daily: null,
      monthly: null,
      yearly: null
    });
  });
});

describe("getEc2OnDemandPricing", () => {
  it("ignores zero priced dimensions when selecting hourly rate", async () => {
    resetEc2PricingCache();
    const sendMock = mock.method(PricingClient.prototype, "send", async () => ({
      PriceList: [
        JSON.stringify({
          product: {
            attributes: {
              instanceType: "t3.micro",
              operatingSystem: "Linux",
              tenancy: "Shared",
              preInstalledSw: "NA",
              location: "US East (N. Virginia)",
              regionCode: "us-east-1"
            }
          },
          terms: {
            OnDemand: {
              ondemandTerm: {
                priceDimensions: {
                  zeroRate: {
                    unit: "Hrs",
                    pricePerUnit: { USD: "0.000000" }
                  },
                  positiveRate: {
                    unit: "Hrs",
                    pricePerUnit: { USD: "0.011600" }
                  }
                }
              }
            }
          }
        })
      ]
    }));

    const rateKey = buildRateKey({
      instanceType: "t3.micro",
      operatingSystem: "Linux",
      tenancy: "Shared",
      preInstalledSw: "NA"
    });

    try {
      const { rates, getPrice } = await getEc2OnDemandPricing("us-east-1", { requiredKeys: [rateKey] });
      const entry = rates.get(rateKey);
      assert.ok(entry, "expected rate to be returned");
      assert.equal(entry.price, 0.0116);
      assert.equal(
        getPrice({
          instanceType: "t3.micro",
          operatingSystem: "Linux",
          tenancy: "Shared",
          preInstalledSw: "NA"
        }),
        0.0116
      );
    } finally {
      sendMock.mock.restore();
      resetEc2PricingCache();
    }
  });
});
