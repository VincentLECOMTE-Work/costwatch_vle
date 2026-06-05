import * as aws from "./ce-aws.js";
import { getOrSetAwsCache } from "./aws-cache.js";

function ttlFromEnv(name, fallbackSeconds) {
  const raw = process.env[name];
  const n = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0) return fallbackSeconds;
  return n;
}

function toIsoDate(value) {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toISOString().slice(0, 10);
}

function normalizeList(value, mapFn = (x) => x) {
  const arr = Array.isArray(value) ? value : String(value || "").split(",");
  return arr
    .map(v => mapFn(String(v || "").trim()))
    .filter(Boolean)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function normalizeCoverageParams(params = {}) {
  const start = toIsoDate(params.start);
  const end = toIsoDate(params.end);
  const groupBy = normalizeList(params.groupBy, s => s.toUpperCase());
  return { start, end, groupBy };
}

function normalizeUtilizationParams(params = {}) {
  const start = toIsoDate(params.start);
  const end = toIsoDate(params.end);
  const granularity = String(params.granularity || "DAILY").trim().toUpperCase() === "MONTHLY" ? "MONTHLY" : "DAILY";
  return { start, end, granularity };
}

function normalizeInventoryParams(params = {}) {
  const states = normalizeList(params.states, s => s.toLowerCase().replace(/_/g, "-"));
  return { states };
}

function keyCoverage(params) {
  return `sp:coverage:${params.start || "-"}:${params.end || "-"}:${params.groupBy.join("|") || "-"}`;
}

function keyUtilization(params) {
  return `sp:utilization:${params.start || "-"}:${params.end || "-"}:${params.granularity}`;
}

function keyInventory(params) {
  return `sp:inventory:${params.states.join("|") || "-"}`;
}

export async function getCachedSpCoverage(params = {}, { forceRefresh = false } = {}) {
  const normalized = normalizeCoverageParams(params);
  const ttlSeconds = ttlFromEnv("SP_COVERAGE_CACHE_TTL_SECONDS", 21600);
  const { value } = await getOrSetAwsCache({
    cacheKey: keyCoverage(normalized),
    ttlSeconds,
    forceRefresh,
    fetcher: () => aws.getSpCoverage({ ...params, ...normalized, groupBy: normalized.groupBy })
  });
  return Array.isArray(value) ? value : [];
}

export async function getCachedSpUtilization(params = {}, { forceRefresh = false } = {}) {
  const normalized = normalizeUtilizationParams(params);
  const ttlSeconds = ttlFromEnv("SP_UTILIZATION_CACHE_TTL_SECONDS", 21600);
  const { value } = await getOrSetAwsCache({
    cacheKey: keyUtilization(normalized),
    ttlSeconds,
    forceRefresh,
    fetcher: () => aws.getSpUtilization({ ...params, ...normalized })
  });
  return value && typeof value === "object" ? value : {
    rows: [],
    summary: {
      totalCommitment: 0,
      usedCommitment: 0,
      unusedCommitment: 0,
      utilizationPct: 0,
      savings: { netSavings: 0, onDemandCostEquivalent: 0, totalSavings: 0 },
      amortizedCommitment: { total: 0, used: 0, unused: 0 }
    }
  };
}

export async function getCachedSavingsPlansInventory(params = {}, { forceRefresh = false } = {}) {
  const normalized = normalizeInventoryParams(params);
  const ttlSeconds = ttlFromEnv("SP_INVENTORY_CACHE_TTL_SECONDS", 21600);
  const { value } = await getOrSetAwsCache({
    cacheKey: keyInventory(normalized),
    ttlSeconds,
    forceRefresh,
    fetcher: () => aws.listSavingsPlans({ states: normalized.states })
  });
  return Array.isArray(value) ? value : [];
}

export async function warmSavingsPlansCache({
  start,
  end,
  forceRefresh = false
} = {}) {
  const coverageBase = { start, end };
  await Promise.all([
    getCachedSpCoverage({ ...coverageBase, groupBy: [] }, { forceRefresh }),
    getCachedSpCoverage({ ...coverageBase, groupBy: ["REGION", "INSTANCE_TYPE_FAMILY"] }, { forceRefresh }),
    getCachedSpUtilization({ ...coverageBase, granularity: "DAILY" }, { forceRefresh }),
    getCachedSavingsPlansInventory({ states: ["active"] }, { forceRefresh })
  ]);
}
