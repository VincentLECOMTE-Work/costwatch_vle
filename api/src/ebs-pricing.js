import { PricingClient, GetProductsCommand } from "@aws-sdk/client-pricing";

const REGION_TO_LOCATION = {
  "us-east-1": "US East (N. Virginia)",
  "us-east-2": "US East (Ohio)",
  "us-west-1": "US West (N. California)",
  "us-west-2": "US West (Oregon)",
  "ca-central-1": "Canada (Central)",
  "eu-central-1": "EU (Frankfurt)",
  "eu-west-1": "EU (Ireland)",
  "eu-west-2": "EU (London)",
  "eu-west-3": "EU (Paris)",
  "eu-north-1": "EU (Stockholm)",
  "eu-south-1": "EU (Milan)",
  "eu-south-2": "EU (Spain)",
  "eu-central-2": "EU (Zurich)",
  "ap-south-1": "Asia Pacific (Mumbai)",
  "ap-south-2": "Asia Pacific (Hyderabad)",
  "ap-southeast-1": "Asia Pacific (Singapore)",
  "ap-southeast-2": "Asia Pacific (Sydney)",
  "ap-southeast-3": "Asia Pacific (Jakarta)",
  "ap-southeast-4": "Asia Pacific (Melbourne)",
  "ap-northeast-1": "Asia Pacific (Tokyo)",
  "ap-northeast-2": "Asia Pacific (Seoul)",
  "ap-northeast-3": "Asia Pacific (Osaka)",
  "ap-east-1": "Asia Pacific (Hong Kong)",
  "me-south-1": "Middle East (Bahrain)",
  "me-central-1": "Middle East (UAE)",
  "sa-east-1": "South America (Sao Paulo)",
  "af-south-1": "Africa (Cape Town)"
};

const DEFAULT_VOLUME_TYPES = ["gp3", "gp2", "io1", "io2", "st1", "sc1", "standard"];
const GP3_INCLUDED_IOPS = 3000;
const GP3_INCLUDED_THROUGHPUT = 125;
const IO2_TIER_1_LIMIT = 32000;
const IO2_TIER_2_LIMIT = 64000;

const CACHE_TTL_MS = Number.parseInt(process.env.EBS_PRICING_CACHE_TTL_MS || "21600000", 10) || 6 * 60 * 60 * 1000;
const pricingClient = new PricingClient({ region: "us-east-1" });
const CACHE = new Map();
const IN_FLIGHT = new Map();

// Static fallback is only used when AWS Pricing is unreachable. Live pricing wins whenever possible.
const FALLBACK_PRICING = {
  "us-east-1": {
    source: "fallback-static",
    rates: {
      gp3: { storageGbMonth: 0.08, iopsMonth: 0.005, throughputMiBpsMonth: 0.04 },
      gp2: { storageGbMonth: 0.10 },
      io1: { storageGbMonth: 0.125, iopsMonth: 0.065 },
      io2: { storageGbMonth: 0.125, iopsTiers: [{ upTo: IO2_TIER_1_LIMIT, rate: 0.065 }, { upTo: IO2_TIER_2_LIMIT, rate: 0.0455 }, { upTo: Infinity, rate: 0.03185 }] },
      st1: { storageGbMonth: 0.045 },
      sc1: { storageGbMonth: 0.015 },
      standard: { storageGbMonth: 0.05 }
    }
  },
  "eu-west-3": {
    source: "fallback-static",
    rates: {
      gp3: { storageGbMonth: 0.0928, iopsMonth: 0.0058, throughputMiBpsMonth: 0.0464 },
      gp2: { storageGbMonth: 0.116 },
      io1: { storageGbMonth: 0.145, iopsMonth: 0.076 },
      io2: { storageGbMonth: 0.145, iopsTiers: [{ upTo: IO2_TIER_1_LIMIT, rate: 0.076 }, { upTo: IO2_TIER_2_LIMIT, rate: 0.0532 }, { upTo: Infinity, rate: 0.0372 }] },
      st1: { storageGbMonth: 0.053 },
      sc1: { storageGbMonth: 0.0174 },
      standard: { storageGbMonth: 0.058 }
    }
  }
};

function normalizeAttr(value, fallback = "") {
  const v = value === undefined || value === null ? "" : String(value);
  return v.trim() || fallback;
}

function normalizeVolumeType(value) {
  return normalizeAttr(value, "gp3").toLowerCase();
}

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function roundMoney(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 1_000_000) / 1_000_000;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function fallbackRegionPricing(region) {
  const direct = FALLBACK_PRICING[region];
  const base = direct || FALLBACK_PRICING["us-east-1"];
  return {
    region,
    location: REGION_TO_LOCATION[region] || REGION_TO_LOCATION["us-east-1"],
    source: direct ? base.source : "fallback-static-us-east-1",
    currency: "USD",
    rates: cloneJson(base.rates)
  };
}

function mergeRate(base = {}, fetched = {}) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(fetched || {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (value.length) merged[key] = value;
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function mergeRegionPricing(region, fetchedRates = {}) {
  const fallback = fallbackRegionPricing(region);
  let fetchedCount = 0;
  const rates = { ...fallback.rates };
  for (const type of DEFAULT_VOLUME_TYPES) {
    const fetched = fetchedRates[type];
    if (!fetched) continue;
    fetchedCount += 1;
    rates[type] = mergeRate(rates[type], fetched);
  }
  return {
    ...fallback,
    source: fetchedCount ? "aws-pricing" : fallback.source,
    rates
  };
}

function extractOnDemandDimensions(product) {
  const terms = product?.terms?.OnDemand || {};
  const dims = [];
  for (const term of Object.values(terms)) {
    for (const dim of Object.values(term?.priceDimensions || {})) {
      dims.push(dim);
    }
  }
  return dims;
}

function normalizeThroughputRate(price, unit) {
  const unitText = normalizeAttr(unit).toLowerCase();
  if (unitText.includes("gibps") || unitText.includes("gbps")) return price / 1024;
  return price;
}

function parseVolumeTypeProducts(volumeType, products = []) {
  const type = normalizeVolumeType(volumeType);
  const rate = {};
  const iopsTiers = [];
  for (const product of products) {
    const attrs = product?.product?.attributes || {};
    const family = normalizeAttr(product?.product?.productFamily).toLowerCase();
    const group = normalizeAttr(attrs.group).toLowerCase();
    for (const dim of extractOnDemandDimensions(product)) {
      const price = Number(dim?.pricePerUnit?.USD);
      if (!Number.isFinite(price) || price < 0) continue;
      const unit = normalizeAttr(dim?.unit).toLowerCase();
      if (family === "storage" && (unit.includes("gb-mo") || unit.includes("gb-month"))) {
        rate.storageGbMonth = price;
        continue;
      }
      if ((unit.includes("iops") || group.includes("iops")) && !group.includes("i/o requests")) {
        if (type === "io2" && group.includes("tier 3")) {
          iopsTiers.push({ upTo: Infinity, rate: price });
        } else if (type === "io2" && group.includes("tier 2")) {
          iopsTiers.push({ upTo: IO2_TIER_2_LIMIT, rate: price });
        } else if (type === "io2") {
          iopsTiers.push({ upTo: IO2_TIER_1_LIMIT, rate: price });
        } else {
          rate.iopsMonth = price;
        }
        continue;
      }
      if (family.includes("throughput") || group.includes("throughput")) {
        rate.throughputMiBpsMonth = normalizeThroughputRate(price, unit);
      }
    }
  }
  if (iopsTiers.length) {
    const order = (tier) => tier.upTo === Infinity ? Number.MAX_SAFE_INTEGER : tier.upTo;
    rate.iopsTiers = iopsTiers.sort((a, b) => order(a) - order(b));
  }
  return Object.keys(rate).length ? rate : null;
}

async function queryVolumeTypePricing(region, volumeType) {
  const filters = [
    { Type: "TERM_MATCH", Field: "volumeApiName", Value: volumeType }
  ];
  const location = REGION_TO_LOCATION[region];
  if (location) {
    filters.push({ Type: "TERM_MATCH", Field: "location", Value: location });
  } else if (region) {
    filters.push({ Type: "TERM_MATCH", Field: "regionCode", Value: region });
  }

  const products = [];
  let nextToken;
  do {
    const response = await pricingClient.send(new GetProductsCommand({
      ServiceCode: "AmazonEC2",
      Filters: filters,
      MaxResults: 100,
      NextToken: nextToken
    }));
    for (const priceStr of response.PriceList || []) {
      try {
        products.push(JSON.parse(priceStr));
      } catch {
        // Ignore malformed price rows.
      }
    }
    nextToken = response.NextToken;
  } while (nextToken);
  return parseVolumeTypeProducts(volumeType, products);
}

async function fetchRegionPricing(region, volumeTypes = DEFAULT_VOLUME_TYPES) {
  const fetchedRates = {};
  await Promise.all(volumeTypes.map(async (type) => {
    const rate = await queryVolumeTypePricing(region, type);
    if (rate) fetchedRates[type] = rate;
  }));
  return mergeRegionPricing(region, fetchedRates);
}

async function getRegionPricing(region, volumeTypes = DEFAULT_VOLUME_TYPES) {
  const normalizedRegion = normalizeAttr(region, "us-east-1");
  const types = Array.from(new Set((volumeTypes.length ? volumeTypes : DEFAULT_VOLUME_TYPES).map(normalizeVolumeType))).sort();
  const key = `${normalizedRegion}:${types.join(",")}`;
  const cached = CACHE.get(key);
  const now = Date.now();
  if (cached && now - cached.fetchedAt <= CACHE_TTL_MS) return cached.value;
  if (IN_FLIGHT.has(key)) return IN_FLIGHT.get(key);
  const promise = fetchRegionPricing(normalizedRegion, types)
    .catch(() => fallbackRegionPricing(normalizedRegion))
    .then(value => {
      CACHE.set(key, { value, fetchedAt: Date.now() });
      IN_FLIGHT.delete(key);
      return value;
    });
  IN_FLIGHT.set(key, promise);
  return promise;
}

function volumeRegion(volume = {}) {
  const explicit = normalizeAttr(volume.region || volume.Region);
  if (explicit) return explicit;
  const az = normalizeAttr(volume.availabilityZone || volume.az || volume.AvailabilityZone);
  const match = az.match(/^(.+-\d)[a-z]$/i);
  return match ? match[1] : "us-east-1";
}

function tieredIopsCost(iops, tiers = []) {
  if (!Number.isFinite(iops) || iops <= 0 || !tiers.length) return { cost: 0, billable: 0 };
  let remaining = iops;
  let previousLimit = 0;
  let cost = 0;
  for (const tier of tiers) {
    const limit = tier.upTo === null || tier.upTo === undefined ? Infinity : Number(tier.upTo);
    const span = limit === Infinity ? remaining : Math.max(0, Math.min(remaining, limit - previousLimit));
    if (span > 0) {
      cost += span * toNumber(tier.rate);
      remaining -= span;
    }
    previousLimit = limit;
    if (remaining <= 0) break;
  }
  return { cost, billable: iops };
}

export async function getEbsPricingForRegions(regions = [], volumeTypes = DEFAULT_VOLUME_TYPES) {
  const regionList = Array.from(new Set((regions.length ? regions : ["us-east-1"]).map(r => normalizeAttr(r)).filter(Boolean)));
  const typeList = Array.from(new Set((volumeTypes.length ? volumeTypes : DEFAULT_VOLUME_TYPES).map(normalizeVolumeType)));
  const entries = await Promise.all(regionList.map(async region => [region, await getRegionPricing(region, typeList)]));
  return {
    currency: "USD",
    generatedAt: new Date().toISOString(),
    regions: Object.fromEntries(entries)
  };
}

export function estimateEbsVolumeMonthlyCost(volume = {}, pricingByRegion = {}) {
  const region = volumeRegion(volume);
  const type = normalizeVolumeType(volume.volumeType || volume.type || volume.VolumeType);
  const regionPricing = pricingByRegion?.regions?.[region] || pricingByRegion?.[region] || fallbackRegionPricing(region);
  const rates = regionPricing?.rates?.[type] || {};
  const sizeGiB = toNumber(volume.sizeGiB ?? volume.size ?? volume.Size, 0);
  const iopsRaw = volume.iops ?? volume.Iops;
  const throughputRaw = volume.throughput ?? volume.Throughput;
  const provisionedIops = iopsRaw === undefined || iopsRaw === null || iopsRaw === ""
    ? (type === "gp3" ? GP3_INCLUDED_IOPS : 0)
    : toNumber(iopsRaw, 0);
  const provisionedThroughput = throughputRaw === undefined || throughputRaw === null || throughputRaw === ""
    ? (type === "gp3" ? GP3_INCLUDED_THROUGHPUT : 0)
    : toNumber(throughputRaw, 0);

  const storageMonthly = sizeGiB * toNumber(rates.storageGbMonth, 0);
  let iopsBillable = 0;
  let iopsMonthly = 0;
  let throughputBillable = 0;
  let throughputMonthly = 0;
  const assumptions = [];

  if (type === "gp3") {
    iopsBillable = Math.max(0, provisionedIops - GP3_INCLUDED_IOPS);
    throughputBillable = Math.max(0, provisionedThroughput - GP3_INCLUDED_THROUGHPUT);
    iopsMonthly = iopsBillable * toNumber(rates.iopsMonth, 0);
    throughputMonthly = throughputBillable * toNumber(rates.throughputMiBpsMonth, 0);
    assumptions.push(`${GP3_INCLUDED_IOPS} IOPS inclus`, `${GP3_INCLUDED_THROUGHPUT} MiB/s inclus`);
  } else if (type === "io2" && Array.isArray(rates.iopsTiers) && rates.iopsTiers.length) {
    const tiered = tieredIopsCost(provisionedIops, rates.iopsTiers);
    iopsBillable = tiered.billable;
    iopsMonthly = tiered.cost;
  } else if (type === "io1" || type === "io2") {
    iopsBillable = provisionedIops;
    iopsMonthly = iopsBillable * toNumber(rates.iopsMonth, 0);
  }

  if (type === "standard") {
    assumptions.push("I/O requests non incluses: usage non disponible via DescribeVolumes");
  }

  const monthly = storageMonthly + iopsMonthly + throughputMonthly;
  const hasAnyRate = rates.storageGbMonth !== undefined || rates.iopsMonth !== undefined || rates.throughputMiBpsMonth !== undefined || Array.isArray(rates.iopsTiers);
  return {
    monthly: hasAnyRate ? roundMoney(monthly) : null,
    currency: "USD",
    source: regionPricing?.source || "fallback-static",
    region,
    type,
    components: {
      storageMonthly: roundMoney(storageMonthly),
      iopsMonthly: roundMoney(iopsMonthly),
      throughputMonthly: roundMoney(throughputMonthly),
      storageRate: rates.storageGbMonth ?? null,
      iopsRate: rates.iopsMonth ?? null,
      throughputRate: rates.throughputMiBpsMonth ?? null,
      iopsBillable,
      throughputBillable,
      provisionedIops,
      provisionedThroughput,
      sizeGiB
    },
    assumptions
  };
}

export async function addEbsCostEstimates(volumes = []) {
  const volumeList = Array.isArray(volumes) ? volumes : [];
  if (!volumeList.length) {
    return {
      items: [],
      pricing: { currency: "USD", generatedAt: new Date().toISOString(), regions: {} }
    };
  }
  const regions = Array.from(new Set(volumeList.map(volumeRegion).filter(Boolean)));
  const types = Array.from(new Set(volumeList.map(v => normalizeVolumeType(v.volumeType || v.type || v.VolumeType)).filter(Boolean)));
  const pricing = await getEbsPricingForRegions(regions, types);
  const items = volumeList.map(volume => {
    const estimate = estimateEbsVolumeMonthlyCost(volume, pricing.regions);
    return {
      ...volume,
      estimatedMonthlyCost: estimate.monthly,
      costMonthly: estimate.monthly,
      currency: estimate.currency,
      ebsCost: estimate
    };
  });
  return { items, pricing };
}

export const EBS_PRICING_CONSTANTS = {
  GP3_INCLUDED_IOPS,
  GP3_INCLUDED_THROUGHPUT,
  IO2_TIER_1_LIMIT,
  IO2_TIER_2_LIMIT
};
