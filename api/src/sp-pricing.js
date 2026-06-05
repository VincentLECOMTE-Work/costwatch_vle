const PRICING_BASE_URL = process.env.SP_PRICING_BASE_URL || "https://pricing.us-east-1.amazonaws.com";
const OFFER_CODE = "AWSComputeSavingsPlan";
const CATALOG_TTL_MS = Number.parseInt(process.env.SP_PRICING_CACHE_TTL_MS || "", 10) || (12 * 60 * 60 * 1000);

const regionIndexCache = {
  fetchedAt: 0,
  map: new Map()
};
const regionCatalogCache = new Map();

function normalizeText(value = "") {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function normalizeDescription(value = "") {
  return normalizeText(value).toLowerCase();
}

function normalizeRegionCode(value = "") {
  return String(value || "").trim().toLowerCase();
}

function normalizeOperation(value = "") {
  return String(value || "").trim();
}

function normalizeInstanceType(value = "") {
  return String(value || "").trim().toLowerCase();
}

function normalizeTenancy(value = "") {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw || raw === "default") return "shared";
  if (raw === "dedicated") return "dedicated";
  if (raw === "host") return "host";
  return "shared";
}

function usageClassForTenancy(tenancy = "") {
  const normalized = normalizeTenancy(tenancy);
  if (normalized === "dedicated") return "DedicatedUsage";
  if (normalized === "host") return "HostBoxUsage";
  return "BoxUsage";
}

function parseRate(rate) {
  const value = Number(rate?.discountedRate?.price);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function buildAbsUrl(pathname) {
  if (!pathname) return null;
  if (String(pathname).startsWith("http://") || String(pathname).startsWith("https://")) return pathname;
  return `${PRICING_BASE_URL}${pathname}`;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`sp_pricing_fetch_failed:${res.status}:${url}`);
  }
  return res.json();
}

function isNewerTerm(candidate, current) {
  const c = Date.parse(candidate?.effectiveDate || "");
  const e = Date.parse(current?.effectiveDate || "");
  if (Number.isFinite(c) && Number.isFinite(e)) return c > e;
  return false;
}

async function getRegionVersionUrlMap({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && regionIndexCache.map.size && (now - regionIndexCache.fetchedAt) < CATALOG_TTL_MS) {
    return regionIndexCache.map;
  }

  const root = await fetchJson(buildAbsUrl(`/savingsPlan/v1.0/aws/${OFFER_CODE}/current/index.json`));
  const regionIndexUrl = buildAbsUrl(root?.currentOfferVersionUrl);
  if (!regionIndexUrl) {
    throw new Error("sp_pricing_region_index_missing");
  }
  const regionIndex = await fetchJson(regionIndexUrl);
  const regions = Array.isArray(regionIndex?.regions) ? regionIndex.regions : [];
  const nextMap = new Map();
  for (const region of regions) {
    const code = normalizeRegionCode(region?.regionCode);
    const versionUrl = buildAbsUrl(region?.versionUrl);
    if (!code || !versionUrl) continue;
    nextMap.set(code, versionUrl);
  }
  regionIndexCache.map = nextMap;
  regionIndexCache.fetchedAt = now;
  return nextMap;
}

function buildCatalog(regionCode, payload) {
  const terms = Array.isArray(payload?.terms?.savingsPlan) ? payload.terms.savingsPlan : [];
  const termsByDescription = new Map();
  for (const term of terms) {
    const key = normalizeDescription(term?.description);
    if (!key) continue;
    const existing = termsByDescription.get(key);
    if (!existing || isNewerTerm(term, existing)) {
      termsByDescription.set(key, term);
    }
  }
  return {
    regionCode: normalizeRegionCode(regionCode),
    publicationDate: payload?.publicationDate || null,
    termsByDescription,
    terms
  };
}

export async function getSavingsPlanCatalog(regionCode, { forceRefresh = false } = {}) {
  const region = normalizeRegionCode(regionCode);
  if (!region) return null;
  const now = Date.now();
  const cached = regionCatalogCache.get(region);
  if (!forceRefresh && cached && (now - cached.fetchedAt) < CATALOG_TTL_MS) {
    return cached.value;
  }
  const versionMap = await getRegionVersionUrlMap({ forceRefresh });
  const versionUrl = versionMap.get(region);
  if (!versionUrl) return null;
  const payload = await fetchJson(versionUrl);
  const catalog = buildCatalog(region, payload);
  regionCatalogCache.set(region, { fetchedAt: now, value: catalog });
  return catalog;
}

function termMatchesPlanFallback(term, plan = {}) {
  const desc = normalizeDescription(term?.description);
  if (!desc) return false;
  const payment = normalizeText(plan?.paymentOption || "").toLowerCase();
  if (payment && !desc.includes(payment)) return false;

  const years = Number(plan?.termDurationSeconds || plan?.termDurationInSeconds || 0) / (365 * 24 * 3600);
  if (years >= 2.5 && !desc.includes("3 year")) return false;
  if (years >= 0.9 && years <= 1.5 && !desc.includes("1 year")) return false;

  const type = String(plan?.type || plan?.savingsPlanType || plan?.SavingsPlanType || "").toLowerCase();
  if (type.includes("ec2instance") && !desc.includes("ec2 instance savings plan")) return false;
  if (type.includes("compute") && !desc.includes("compute savings plan")) return false;

  const family = String(plan?.instanceFamily || plan?.ec2InstanceFamily || plan?.EC2InstanceFamily || "").trim().toLowerCase();
  if (family && !desc.includes(`${family.toLowerCase()} ec2 instance savings plan`)) return false;
  return true;
}

export function resolveCatalogTermForPlan(catalog, plan = {}) {
  if (!catalog) return null;
  const description = plan?.description || plan?.Description || "";
  const key = normalizeDescription(description);
  if (key) {
    const exact = catalog.termsByDescription.get(key);
    if (exact) return exact;
  }
  const terms = Array.isArray(catalog?.terms) ? catalog.terms : [];
  return terms.find(term => termMatchesPlanFallback(term, plan)) || null;
}

function operationCandidates(operation = "") {
  const op = normalizeOperation(operation);
  if (!op) return [];
  const candidates = [];
  const push = value => {
    if (!value) return;
    if (!candidates.includes(value)) candidates.push(value);
  };
  push(op);
  if (op.endsWith(":box")) {
    push(op.slice(0, -4));
  } else {
    push(`${op}:box`);
  }
  const base = op.split(":")[0];
  push(base);
  return candidates;
}

function pickLowestRate(rates = []) {
  let best = null;
  for (const rate of rates) {
    const value = parseRate(rate);
    if (!(value > 0)) continue;
    if (!best || value < best.value) {
      best = { value, rate };
    }
  }
  return best ? best.value : null;
}

export function resolveSavingsPlanRateForTerm(term, item = {}) {
  const rates = Array.isArray(term?.rates) ? term.rates : [];
  if (!rates.length) return null;
  const instanceType = normalizeInstanceType(item.instanceType || item.type || "");
  if (!instanceType) return null;
  const region = normalizeRegionCode(item.region || "");
  const tenancyClass = usageClassForTenancy(item.tenancy || item.normalizedTenancy || "");

  const candidates = rates.filter(rate => {
    if (normalizeInstanceType(rate?.discountedInstanceType) !== instanceType) return false;
    const discountedRegion = normalizeRegionCode(rate?.discountedRegionCode || "");
    if (region && discountedRegion && discountedRegion !== region) return false;
    const usageType = String(rate?.discountedUsageType || "");
    if (usageType.includes("-Unused")) return false;
    if (!usageType.includes(`-${tenancyClass}:`)) return false;
    return parseRate(rate) !== null;
  });
  if (!candidates.length) return null;

  const operation = normalizeOperation(item.pricingOperation || item.operation || "");
  const ops = operationCandidates(operation);
  for (const op of ops) {
    const opMatches = candidates.filter(rate => normalizeOperation(rate?.discountedOperation) === op);
    const value = pickLowestRate(opMatches);
    if (value !== null) return value;
  }

  if (operation) {
    const base = operation.split(":")[0];
    const relaxed = candidates.filter(rate => normalizeOperation(rate?.discountedOperation).startsWith(`${base}:`) || normalizeOperation(rate?.discountedOperation) === base);
    const value = pickLowestRate(relaxed);
    if (value !== null) return value;
  }

  return pickLowestRate(candidates);
}

export function resetSavingsPlanPricingCache() {
  regionIndexCache.fetchedAt = 0;
  regionIndexCache.map = new Map();
  regionCatalogCache.clear();
}
