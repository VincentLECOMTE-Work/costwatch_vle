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
  "sa-east-1": "South America (São Paulo)",
  "af-south-1": "Africa (Cape Town)"
};

const FALLBACK_REGION = {
  "eu-west-3": "eu-west-1"
};

const CACHE_TTL_MS = Number.parseInt(process.env.EC2_PRICING_CACHE_TTL_MS || "1800000", 10) || 30 * 60 * 1000;
const STALE_CACHE_TTL_MS = Number.parseInt(process.env.EC2_PRICING_STALE_CACHE_TTL_MS || "", 10) || (6 * 60 * 60 * 1000);
const RETRY_MAX_ATTEMPTS = Number.parseInt(process.env.EC2_PRICING_RETRY_ATTEMPTS || "", 10) || 6;
const RETRY_BASE_DELAY_MS = Number.parseInt(process.env.EC2_PRICING_RETRY_BASE_MS || "", 10) || 250;
const EARLY_STOP_SCORE = Number.parseInt(process.env.EC2_PRICING_EARLY_STOP_SCORE || "", 10) || 400;
const pricingClient = new PricingClient({ region: "us-east-1" });
const CACHE = new Map();
const IN_FLIGHT = new Map();

function cacheKey(region) {
  return region || "unknown";
}

function normalizeAttr(value, fallback = "") {
  const v = value === undefined || value === null ? "" : String(value);
  return v.trim() || fallback;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isThrottlingError(err) {
  const name = String(err?.name || err?.Code || err?.code || "").toLowerCase();
  const type = String(err?.__type || "").toLowerCase();
  const msg = String(err?.message || "").toLowerCase();
  if (name.includes("throttl")) return true;
  if (type.includes("throttl")) return true;
  if (msg.includes("rate exceeded")) return true;
  if (msg.includes("throttl")) return true;
  return false;
}

async function sendPricingCommand(command) {
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await pricingClient.send(command);
    } catch (err) {
      if (!isThrottlingError(err) || attempt >= RETRY_MAX_ATTEMPTS) {
        throw err;
      }
      const jitter = Math.floor(Math.random() * 120);
      const delay = Math.min(5000, RETRY_BASE_DELAY_MS * (2 ** (attempt - 1))) + jitter;
      await sleep(delay);
    }
  }
  throw new Error("pricing_retry_exhausted");
}

export function buildRateKey({ instanceType, operatingSystem, tenancy, preInstalledSw }) {
  const keyParts = [
    normalizeAttr(instanceType, "unknown").toLowerCase(),
    normalizeAttr(operatingSystem, "").toLowerCase(),
    normalizeAttr(tenancy, "").toLowerCase(),
    normalizeAttr(preInstalledSw, "na").toLowerCase()
  ];
  return keyParts.join("::");
}

function extractOnDemandPrice(product) {
  const terms = product?.terms?.OnDemand;
  if (!terms) return null;
  let bestPrice = null;
  for (const term of Object.values(terms)) {
    const dimensions = term?.priceDimensions || {};
    for (const dim of Object.values(dimensions)) {
      const unit = normalizeAttr(dim?.unit).toUpperCase();
      if (unit !== "HRS" && unit !== "HR") continue;
      const price = dim?.pricePerUnit?.USD;
      if (price === undefined) continue;
      const parsed = Number(price);
      if (!Number.isFinite(parsed) || parsed <= 0) continue;
      if (bestPrice === null || parsed < bestPrice) {
        bestPrice = parsed;
      }
    }
  }
  return bestPrice;
}

function candidateScore(attrs = {}) {
  let score = 0;
  const capacity = normalizeAttr(attrs.capacitystatus).toLowerCase();
  if (capacity === "used") score += 300;
  else if (capacity === "unusedcapacityreservation") score += 100;

  const licenseModel = normalizeAttr(attrs.licenseModel).toLowerCase();
  if (licenseModel === "no license required") score += 80;
  else if (licenseModel.includes("license included")) score += 40;
  else if (licenseModel.includes("bring your own license")) score += 10;

  const marketOption = normalizeAttr(attrs.marketoption).toLowerCase();
  if (marketOption === "ondemand") score += 20;

  const preInstalledSw = normalizeAttr(attrs.preInstalledSw, "NA").toLowerCase();
  if (preInstalledSw === "na") score += 15;

  const operation = normalizeAttr(attrs.operation).toLowerCase();
  if (operation === "runinstances") score += 6;
  if (operation.endsWith(":box")) score -= 2;

  return score;
}

function shouldReplaceRate(existing, candidate) {
  if (!existing) return true;
  const existingScore = Number(existing.selectionScore ?? Number.NEGATIVE_INFINITY);
  const candidateScoreValue = Number(candidate.selectionScore ?? Number.NEGATIVE_INFINITY);
  if (candidateScoreValue > existingScore) return true;
  if (candidateScoreValue < existingScore) return false;
  return candidate.price < existing.price;
}

function parseRateKey(key) {
  if (!key) return null;
  const parts = String(key).split("::").map(part => part ?? "");
  while (parts.length < 4) parts.push("");
  const [instanceType, operatingSystem, tenancy, preInstalledSw] = parts;
  return {
    instanceType: normalizeAttr(instanceType, "unknown").toLowerCase(),
    operatingSystem: normalizeAttr(operatingSystem).toLowerCase(),
    tenancy: normalizeAttr(tenancy).toLowerCase(),
    preInstalledSw: normalizeAttr(preInstalledSw, "na").toLowerCase()
  };
}

function canonicalOperatingSystem(os) {
  const value = normalizeAttr(os).toLowerCase();
  const map = {
    linux: "Linux",
    "linux/unix": "Linux",
    windows: "Windows",
    rhel: "RHEL",
    redhat: "RHEL",
    suse: "SUSE",
    sles: "SUSE",
    ubuntu: "Linux",
    amzn: "Linux",
    "na": "NA"
  };
  return map[value] || null;
}

function canonicalTenancy(tenancy) {
  const value = normalizeAttr(tenancy).toLowerCase();
  const map = {
    shared: "Shared",
    dedicated: "Dedicated",
    host: "Host"
  };
  return map[value] || null;
}

function buildBaseFilters({ location, regionCode }) {
  const filters = [
    { Type: "TERM_MATCH", Field: "productFamily", Value: "Compute Instance" }
  ];
  if (location) {
    filters.push({ Type: "TERM_MATCH", Field: "location", Value: location });
  }
  if (regionCode) {
    filters.push({ Type: "TERM_MATCH", Field: "regionCode", Value: regionCode });
  }
  return filters;
}

async function queryPricing({ filters, requiredKeys, location, regionCode }) {
  const neededKeys = requiredKeys && requiredKeys.size
    ? new Set(Array.from(requiredKeys, k => k.toLowerCase()))
    : null;
  const rates = new Map();
  let nextToken;
  do {
    const response = await sendPricingCommand(new GetProductsCommand({
      ServiceCode: "AmazonEC2",
      Filters: filters,
      NextToken: nextToken
    }));
    for (const priceStr of response.PriceList || []) {
      let product;
      try {
        product = JSON.parse(priceStr);
      } catch {
        continue;
      }
      const attrs = product?.product?.attributes || {};
      const operation = normalizeAttr(attrs.operation).toLowerCase();
      if (operation && !operation.startsWith("runinstances")) continue;
      if (normalizeAttr(attrs.capacitystatus).toLowerCase() === "spot") continue;
      const instanceType = attrs.instanceType;
      const tenancy = attrs.tenancy;
      const operatingSystem = attrs.operatingSystem;
      const preInstalledSw = attrs.preInstalledSw;
      if (!instanceType || !operatingSystem || !tenancy) continue;
      const price = extractOnDemandPrice(product);
      if (price === null) continue;
      const key = buildRateKey({ instanceType, operatingSystem, tenancy, preInstalledSw });
      if (neededKeys && !neededKeys.has(key)) continue;
      const existing = rates.get(key);
      const candidate = {
        price,
        currency: "USD",
        instanceType,
        operatingSystem,
        tenancy,
        preInstalledSw: normalizeAttr(preInstalledSw, "NA"),
        operation: normalizeAttr(attrs.operation),
        usageType: normalizeAttr(attrs.usagetype),
        licenseModel: normalizeAttr(attrs.licenseModel),
        capacityStatus: normalizeAttr(attrs.capacitystatus),
        location: attrs.location || location || null,
        region: regionCode,
        selectionScore: candidateScore(attrs)
      };
      if (shouldReplaceRate(existing, candidate)) {
        rates.set(key, {
          ...candidate
        });
      }
      if (neededKeys) {
        const current = rates.get(key);
        if (current && Number(current.selectionScore || 0) >= EARLY_STOP_SCORE) {
          neededKeys.delete(key);
        }
      }
    }
    nextToken = response.NextToken;
    if (neededKeys && neededKeys.size === 0) {
      break;
    }
  } while (nextToken);

  return rates;
}

function groupRequiredKeys(requiredKeys) {
  const groups = new Map();
  const ungroupable = new Set();
  if (!requiredKeys) {
    return { groups: [], ungroupable };
  }
  for (const key of requiredKeys) {
    const parsed = parseRateKey(key);
    if (!parsed || !parsed.instanceType || parsed.instanceType === "unknown") {
      ungroupable.add(key);
      continue;
    }
    const groupKey = [parsed.instanceType, parsed.operatingSystem, parsed.tenancy].join("::");
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        instanceType: parsed.instanceType,
        operatingSystem: parsed.operatingSystem,
        tenancy: parsed.tenancy,
        keys: new Set()
      };
      groups.set(groupKey, group);
    }
    group.keys.add(key);
  }
  return { groups: Array.from(groups.values()), ungroupable };
}

async function fetchPricing({ region, location, requiredKeys }) {
  const regionCode = normalizeAttr(region);
  const baseFilters = buildBaseFilters({ location, regionCode });
  if (!requiredKeys || requiredKeys.size === 0) {
    return queryPricing({ filters: baseFilters, requiredKeys: null, location, regionCode });
  }

  const allRates = new Map();
  const requiredKeySet = new Set(Array.from(requiredKeys, k => k.toLowerCase()));
  const { groups, ungroupable } = groupRequiredKeys(requiredKeySet);
  const missingKeys = new Set(requiredKeySet);

  for (const group of groups) {
    const groupFilters = baseFilters.slice();
    groupFilters.push({ Type: "TERM_MATCH", Field: "instanceType", Value: group.instanceType });
    const osValue = canonicalOperatingSystem(group.operatingSystem);
    if (osValue) {
      groupFilters.push({ Type: "TERM_MATCH", Field: "operatingSystem", Value: osValue });
    }
    const tenancyValue = canonicalTenancy(group.tenancy);
    if (tenancyValue) {
      groupFilters.push({ Type: "TERM_MATCH", Field: "tenancy", Value: tenancyValue });
    }
    const groupRates = await queryPricing({
      filters: groupFilters,
      requiredKeys: group.keys,
      location,
      regionCode
    });
    for (const [key, value] of groupRates.entries()) {
      allRates.set(key, value);
      missingKeys.delete(key);
    }
  }

  for (const key of ungroupable) {
    missingKeys.add(key);
  }

  if (missingKeys.size > 0) {
    const remainingRates = await queryPricing({
      filters: baseFilters,
      requiredKeys: missingKeys,
      location,
      regionCode
    });
    for (const [key, value] of remainingRates.entries()) {
      allRates.set(key, value);
      missingKeys.delete(key);
    }
  }

  return allRates;
}

function normalizeRequiredKeys(keys = []) {
  return Array.from(new Set(keys.filter(Boolean).map(k => String(k).toLowerCase())));
}

function mergeRates(target, source) {
  if (!source) return target;
  const out = target ? new Map(target) : new Map();
  for (const [key, value] of source.entries()) {
    const existing = out.get(key);
    if (shouldReplaceRate(existing, value)) {
      out.set(key, value);
    }
  }
  return out;
}

export async function getEc2OnDemandPricing(region, options = {}) {
  const key = cacheKey(region);
  const now = Date.now();
  const requiredKeys = normalizeRequiredKeys(options.requiredKeys);
  const cached = CACHE.get(key);
  const cachedRates = cached?.value?.rates;
  const cacheAge = cached ? (now - cached.timestamp) : Number.POSITIVE_INFINITY;
  const hasAllCached = requiredKeys.length
    ? requiredKeys.every(k => cachedRates?.has(k))
    : !!cachedRates;
  if (cached && hasAllCached && (cacheAge < CACHE_TTL_MS || cacheAge < STALE_CACHE_TTL_MS)) {
    return cached.value;
  }

  const existingInFlight = IN_FLIGHT.get(key);
  if (existingInFlight) {
    try {
      const shared = await existingInFlight;
      const sharedRates = shared?.rates;
      const sharedComplete = requiredKeys.length
        ? requiredKeys.every(k => sharedRates?.has(k))
        : !!sharedRates;
      if (sharedComplete) {
        return shared;
      }
    } catch {
      // ignore and continue with local fetch/fallback
    }
  }

  const refreshPromise = (async () => {
    const location = REGION_TO_LOCATION[region];
    let rates = cachedRates ? new Map(cachedRates) : new Map();
    const keysToFetch = requiredKeys.length
      ? requiredKeys.filter(rateKey => !rates.has(rateKey))
      : [];
    const neededSet = requiredKeys.length
      ? (keysToFetch.length ? new Set(keysToFetch) : null)
      : null;

    try {
      if (!requiredKeys.length || neededSet?.size) {
        const freshRates = await fetchPricing({ region, location, requiredKeys: neededSet });
        rates = mergeRates(rates, freshRates);
      }
    } catch (err) {
      if (cached && cacheAge < STALE_CACHE_TTL_MS) {
        console.warn("ec2-pricing using stale cache after fetch error", region, err?.name || err?.message || err);
        return cached.value;
      }
      throw err;
    }

    let meta = { region, location, fallback: null };
    let missingKeys = requiredKeys.length ? requiredKeys.filter(rateKey => !rates.has(rateKey)) : [];
    if (missingKeys.length && FALLBACK_REGION[region]) {
      const fallbackRegion = FALLBACK_REGION[region];
      const fallbackLocation = REGION_TO_LOCATION[fallbackRegion];
      try {
        const fallbackRates = await fetchPricing({
          region: fallbackRegion,
          location: fallbackLocation,
          requiredKeys: new Set(missingKeys)
        });
        rates = mergeRates(rates, fallbackRates);
        meta = { region, location, fallback: fallbackRegion };
        missingKeys = requiredKeys.length ? requiredKeys.filter(rateKey => !rates.has(rateKey)) : [];
      } catch (err) {
        if (!(cached && cacheAge < STALE_CACHE_TTL_MS)) {
          throw err;
        }
        console.warn("ec2-pricing fallback fetch failed, using stale cache", region, err?.name || err?.message || err);
        return cached.value;
      }
    }

    const result = {
      meta,
      rates,
      getPrice(info) {
        if (!info) return null;
        const rateKey = buildRateKey(info);
        const entry = rates?.get(rateKey);
        return entry ? entry.price : null;
      }
    };
    CACHE.set(key, { timestamp: Date.now(), value: result });
    return result;
  })();

  IN_FLIGHT.set(key, refreshPromise);
  try {
    return await refreshPromise;
  } finally {
    if (IN_FLIGHT.get(key) === refreshPromise) {
      IN_FLIGHT.delete(key);
    }
  }
}

export function deriveEffectiveHourlyRate({
  onDemandHourly,
  riHourly,
  includeReserved
}) {
  const onDemand = Number.isFinite(onDemandHourly) ? onDemandHourly : null;
  const reserved = Number.isFinite(riHourly) ? riHourly : null;
  if (includeReserved && reserved !== null) return reserved;
  return onDemand;
}

const HOURS_IN_DAY = 24;
const DAYS_IN_MONTH = 30;
const DAYS_IN_YEAR = 365;

export function projectTimeframes(hourlyRate, options = {}) {
  if (!Number.isFinite(hourlyRate) || hourlyRate < 0) {
    return {
      hourly: null,
      daily: null,
      monthly: null,
      yearly: null
    };
  }
  const {
    dailyHours = HOURS_IN_DAY,
    monthlyDays = DAYS_IN_MONTH,
    yearlyDays = DAYS_IN_YEAR
  } = options || {};
  const normalizedDailyHours = Number.isFinite(dailyHours) && dailyHours > 0 ? dailyHours : HOURS_IN_DAY;
  const normalizedMonthlyDays = Number.isFinite(monthlyDays) && monthlyDays > 0 ? monthlyDays : DAYS_IN_MONTH;
  const normalizedYearlyDays = Number.isFinite(yearlyDays) && yearlyDays > 0 ? yearlyDays : DAYS_IN_YEAR;
  const daily = hourlyRate * normalizedDailyHours;
  return {
    hourly: hourlyRate,
    daily,
    monthly: daily * normalizedMonthlyDays,
    yearly: daily * normalizedYearlyDays
  };
}

export function resetEc2PricingCache() {
  CACHE.clear();
  IN_FLIGHT.clear();
}
