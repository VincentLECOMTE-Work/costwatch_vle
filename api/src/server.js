import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import fs from "fs";
import path from "path";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { EC2Client, DescribeInstancesCommand, DescribeVolumesCommand, DescribeReservedInstancesCommand, DescribeRegionsCommand } from "@aws-sdk/client-ec2";
import { fileURLToPath } from "url";
import { query } from "./db.js";

import {

  listAccountsCE,
  getTopCombos,
  getCostsByService,
  getDailyTotalCosts,
  getRiCoverage,
  getRiUtilization,
  getSpCoverage,
  getSpUtilization,
  listSavingsPlans
} from "./ce.js";
import {
  listVpcs,
  listLoadBalancers,
  listTransitGatewayAttachments,
  listVpcPeeringConnections,
  listVpcEndpoints,
  listNatGateways,
  listNetworkInterfaces
} from "./network.js";
import { getNetworkFinOps } from "./network-finops.js";
import { getOrSetAwsCache } from "./aws-cache.js";
import { getTopCombosEx } from "./ce.js";

import {
  listInstances,
  listVolumes,
  listReservedInstances,
  attachRiCoverageToInstances,
  matchInstancesAndReservations
} from "./ri.js";
import { getAccounts, accountNameMap } from "./accounts.js";
import { friendlyClassLabel, getBucketTimeseries, getS3PricingTable, listS3Buckets } from "./s3.js";
import { getEc2OnDemandPricing, deriveEffectiveHourlyRate, projectTimeframes, buildRateKey } from "./ec2-pricing.js";
import { addEbsCostEstimates } from "./ebs-pricing.js";
import { getS3LatestSnapshot, getS3SeriesFromDb } from "./s3-db.js";
import { getInstanceSchedule, debugInstanceScheduleSearch } from "./schedules.js";
import { applySavingsPlansCoverage } from "./sp-allocation.js";
import { getSavingsPlanCatalog, resolveCatalogTermForPlan, resolveSavingsPlanRateForTerm } from "./sp-pricing.js";
import { getEc2SnapshotSummary } from "./ec2-snapshots.js";
import { getEbsSnapshotSummary } from "./ebs-snapshots.js";
import {
  getCostAnomalies,
  getCostBreakdown,
  getCostForecast,
  getCostHeatmap,
  getCostTrends,
  getCoverageSummary,
  getDataQuality,
  getDbRuntimeStatus,
  getFinOpsActions,
  getFinOpsActionStates,
  getInsightDrilldown,
  setFinOpsActionState,
  getS3Growth
} from "./db-insights.js";

function defaultDateRange(){
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 30);
  const toIso = (d) => d.toISOString().slice(0, 10);
  return { start: toIso(start), end: toIso(end) };
}
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const __DATA_FROM_FLAG = String(process.env.DATA_FROM || process.env.data_from || "LOCAL_DB").toUpperCase();
const __AWS_LIVE_ENABLED = ["1", "true", "yes", "on"].includes(String(process.env.AWS_LIVE_ENABLED || process.env.ALLOW_AWS_LIVE || "").toLowerCase());
const __DB_ONLY_MODE = (__DATA_FROM_FLAG === "LOCAL_DB" || __DATA_FROM_FLAG === "DB") && !__AWS_LIVE_ENABLED;

const app = express();
const trustProxyRaw = String(process.env.TRUST_PROXY || "1").trim();
const trustProxyValue = /^\d+$/.test(trustProxyRaw)
  ? Number(trustProxyRaw)
  : ["true", "on", "yes"].includes(trustProxyRaw.toLowerCase())
    ? true
    : !["false", "0", "off"].includes(trustProxyRaw.toLowerCase()) && trustProxyRaw;
app.set("trust proxy", trustProxyValue);
app.set('etag', false);
app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000),
  max: Number(process.env.RATE_LIMIT_MAX || 600),
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === "/api/health"
}));
app.use((req,res,next)=>{
  res.set('Cache-Control','no-store');
  next();
});
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || "1mb" }));

const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const CORS_ORIGINS = parseList(CORS_ORIGIN);
app.use(cors({
  origin(origin, callback) {
    if (!origin || CORS_ORIGIN === "*" || CORS_ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error("cors_origin_not_allowed"));
  }
}));

const BASIC_AUTH = String(process.env.BASIC_AUTH || "").trim();
if (BASIC_AUTH) {
  const expected = Buffer.from(BASIC_AUTH, "utf8").toString("base64");
  app.use((req, res, next) => {
    if (req.path === "/api/health") return next();
    const header = String(req.headers.authorization || "");
    if (header === `Basic ${expected}`) return next();
    res.set("WWW-Authenticate", 'Basic realm="Costwatch"');
    return res.status(401).json({ error: "authentication_required" });
  });
}

// -------- Accounts-config loader --------
function tryReadJson(p){
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; }
}

function findAccountsConfigPath(){
  const cand = [];
  if (process.env.ACCOUNTS_CONFIG) cand.push(process.env.ACCOUNTS_CONFIG);
  if (process.env.ACCOUNTS_CONFIG_PATH) cand.push(process.env.ACCOUNTS_CONFIG_PATH);
  cand.push("/app/src/accounts-config.json");
  cand.push("/app/accounts-config.json");
  cand.push(path.join(__dirname, "accounts-config.json"));
  cand.push(path.join(process.cwd(), "accounts-config.json"));
  // also try relative api/src/..
  cand.push(path.join(__dirname, "..", "accounts-config.json"));
  for (const p of cand){
    if (!p) continue;
    try {
      if (fs.existsSync(p)) {
        const parsed = tryReadJson(p);
        if (parsed && (parsed.static || parsed.assumeRoles)) return p;
      }
    } catch { /* ignore */ }
  }
  return null;
}

let ACCOUNTS_CACHE = null;
function loadAccountsConfig(){
  if (ACCOUNTS_CACHE) return ACCOUNTS_CACHE;
  const p = findAccountsConfigPath();
  const cfg = (p ? tryReadJson(p) : null) || { static: [], assumeRoles: [] };
  ACCOUNTS_CACHE = { path: p, config: cfg };
  return ACCOUNTS_CACHE;
}

function getStaticAccounts(){
  const { config } = loadAccountsConfig();
  const arr = Array.isArray(config?.static) ? config.static : [];
  // normalize
  return arr.map(a => ({
    accountId: String(a.accountId || "").trim(),
    accountName: a.accountName || undefined,
    accessKeyId: a.accessKeyId,
    secretAccessKey: a.secretAccessKey
  })).filter(a => a.accountId);
}

function isDbOnlyMode() {
  return __DB_ONLY_MODE;
}

function sendDbOnly(res, payload = {}) {
  return res.json({
    dbOnly: true,
    source: "db",
    dataFrom: __DATA_FROM_FLAG,
    awsLiveAllowed: false,
    ...payload
  });
}

async function listDbAccountIds() {
  try {
    const { rows } = await query(`
      select account_id
        from cost_daily
       where nullif(account_id, '') is not null
       group by account_id
      union
      select account_id
        from s3_bucket_daily
       where nullif(account_id, '') is not null
       group by account_id
       order by account_id
    `);
    return (rows || []).map(row => String(row.account_id || "").trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// -------- Helpers --------
function parseList(v){
  if (!v) return [];
  return String(v).split(",").map(s => s.trim()).filter(Boolean);
}

function parseBooleanParam(value, fallback = true) {
  if (value === undefined || value === null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function normalizeInstanceOperatingSystem(platform = "") {
  const value = String(platform || "").toLowerCase();
  if (!value) return "linux";
  if (value.includes("windows")) return "windows";
  if (value.includes("red hat") || value.includes("rhel")) return "rhel";
  if (value.includes("suse")) return "suse";
  return "linux";
}

function normalizeInstanceTenancy(tenancy = "") {
  const value = String(tenancy || "").toLowerCase();
  if (value === "dedicated") return "dedicated";
  if (value === "host") return "host";
  return "shared";
}

function getTagValue(inst, key) {
  if (!inst || !key) return undefined;
  const map = inst.tagMap;
  if (map && Object.prototype.hasOwnProperty.call(map, key)) {
    return map[key];
  }
  const lowerKey = String(key).toLowerCase();
  if (map && Object.prototype.hasOwnProperty.call(map, lowerKey)) {
    return map[lowerKey];
  }
  if (Array.isArray(inst.tags)) {
    const found = inst.tags.find(tag => {
      const tagKey = String(tag?.key || tag?.Key || "");
      return tagKey === key || tagKey.toLowerCase() === lowerKey;
    });
    if (found) {
      return found.value ?? found.Value;
    }
  }
  return undefined;
}

function resolveScheduleDailyHours(schedule) {
  if (!schedule || !schedule.metrics) return null;
  const avgActive = schedule.metrics.averageDailyHours;
  if (Number.isFinite(avgActive) && avgActive > 0) return avgActive;
  const avgAllDays = schedule.metrics.averageDailyHoursAllDays;
  if (Number.isFinite(avgAllDays) && avgAllDays > 0) return avgAllDays;
  return null;
}
function pickDates(q){
  let { start, end } = q || {};
  return { start, end };
}



// Resolve accounts to use for EC2/EBS/RI calls. If no static accounts are configured,
// fall back to the current principal (default credential provider chain).
async function resolveAccountsOrDefault(req) {
  const accs = getStaticAccounts();
  if (Array.isArray(accs) && accs.length) return accs;
  if (isDbOnlyMode()) {
    const ids = await listDbAccountIds();
    return ids.length ? ids.map(accountId => ({ accountId })) : [{ accountId: "unknown" }];
  }
  const regions = resolveRegions(req);
  const probeRegion = regions[0] || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
  try {
    const sts = new STSClient({ region: probeRegion });
    const id = await sts.send(new GetCallerIdentityCommand({}));
    if (id && id.Account) {
      return [{ accountId: String(id.Account) }];
    }
  } catch (e) {
    console.error("resolveAccountsOrDefault: STS GetCallerIdentity failed", e);
  }
  // As a last resort, return a single anonymous account object to still try default creds
  return [{ accountId: "unknown" }];
}


// Resolve effective regions: ?regions=eu-west-3,us-east-1 > EC2_REGIONS > AWS_REGION
function resolveRegions(req){
  const q = (req && (req.query?.regions || req.query?.region)) ? String(req.query.regions || req.query.region) : "";
  const listFromQuery = q ? String(q).split(",").map(s=>s.trim()).filter(Boolean) : [];
  const envList = (process.env.EC2_REGIONS || "").split(",").map(s=>s.trim()).filter(Boolean);
  const fromEnv = envList.length ? envList : [];
  const fromAwsRegion = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "";
  const base = listFromQuery.length ? listFromQuery : (fromEnv.length ? fromEnv : (fromAwsRegion ? [fromAwsRegion] : ["us-east-1"]));
  // de-dup
  return Array.from(new Set(base));
}

// -------- Routes --------
app.get("/api/health", (req, res) => res.json({ ok: true }));

app.get("/api/debug/accounts-config", (req, res) => {
  const r = loadAccountsConfig();
  res.json({
    found: !!r.path,
    path: r.path || null,
    hasStatic: Array.isArray(r.config?.static),
    countStatic: (r.config?.static || []).length
  });
});

app.get("/api/accounts", async (req, res) => {
  try {
    if (isDbOnlyMode()) {
      const [aliasAccounts, dbIds] = await Promise.all([
        getAccounts().catch(() => []),
        listDbAccountIds()
      ]);
      const byId = new Map();
      for (const a of aliasAccounts || []) {
        const id = String(a.id || a.accountId || "").trim();
        if (id) byId.set(id, { accountId: id, accountName: a.name || a.accountName || id });
      }
      for (const id of dbIds) {
        if (!byId.has(id)) byId.set(id, { accountId: id, accountName: id });
      }
      return res.json(Array.from(byId.values()).sort((a, b) => a.accountId.localeCompare(b.accountId)));
    }
    // Prefer Organizations + aliases when possible
    try {
      const orgAccounts = await getAccounts();
      if (Array.isArray(orgAccounts) && orgAccounts.length){
        const rows = orgAccounts.map(a => ({ accountId: String(a.id), accountName: a.name || String(a.id) }));
        return res.json(rows);
      }
    } catch {}
    // Fallback to CE + static
    const ceAccounts = await listAccountsCE(pickDates(req.query));
    const byId = new Map(ceAccounts.map(a => [a.accountId, a]));
    // merge with static
    for (const s of getStaticAccounts()){
      if (!byId.has(s.accountId)){
        byId.set(s.accountId, { accountId: s.accountId, accountName: s.accountName || s.accountId });
      }
    }
    const rows = Array.from(byId.values()).sort((a,b)=> a.accountId.localeCompare(b.accountId));
    res.json(rows);
  } catch (e){
    console.error("accounts", e);
    const rows = getStaticAccounts().map(a => ({ accountId: a.accountId, accountName: a.accountName || a.accountId }));
    res.json(rows);
  }
});

app.get("/api/costs/by-service", async (req, res) => {
  try {
    const { metric = "UnblendedCost" } = req.query;
    const accounts = parseList(req.query.accounts);
    const rows = await getCostsByService({ ...pickDates(req.query), metric, accounts });
    res.json(rows);
  } catch (e) {
    console.error("costs/by-service", e);
    res.status(500).json({ error: "costs_by_service_failed" });
  }
});

app.get("/api/costs/daily-total", async (req, res) => {
  try {
    const { metric = "UnblendedCost" } = req.query;
    const accounts = parseList(req.query.accounts);
    const rows = await getDailyTotalCosts({ ...pickDates(req.query), metric, accounts });
    res.json(rows);
  } catch (e) {
    console.error("costs/daily-total", e);
    res.status(500).json({ error: "costs_daily_total_failed" });
  }
});

app.get("/api/costs/top-combos", async (req, res) => {
  try {
    const { metric = "UnblendedCost" } = req.query;
    const accounts = parseList(req.query.accounts);
    const limit = Number(req.query.limit || 10);
    let rows = await getTopCombosEx({ ...pickDates(req.query), limit, metric, accounts });
    // Attach account_name using aliases/org map
    try {
      const amap = await accountNameMap();
      rows = rows.map(r => ({ ...r, account_name: amap.get(r.linked_account) || r.account_name || r.linked_account }));
    } catch {}
    res.json({ rows });
  } catch (e) {
    console.error("costs/top-combos", e);
    res.status(500).json({ error: "top_combos_failed" });
  }
});

app.get("/api/ri/coverage", async (req, res) => {
  try {
    const by = req.query.by || req.query.groupBy || "";
    const groupBy = parseList(by);
    const rows = await getRiCoverage({ ...pickDates(req.query), groupBy });
    res.json(rows);
  } catch (e) {
    console.error("ri/coverage", e);
    res.status(500).json({ error: "ri_coverage_failed" });
  }
});

app.get("/api/ri/utilization", async (req, res) => {
  try {
    const by = req.query.by || req.query.groupBy || "";
    const groupBy = parseList(by);
    const rows = await getRiUtilization({ ...pickDates(req.query), groupBy });
    res.json(rows);
  } catch (e) {
    console.error("ri/utilization", e);
    res.status(500).json({ error: "ri_utilization_failed" });
  }
});

app.get("/api/sp/coverage", async (req, res) => {
  try {
    const by = req.query.by || req.query.groupBy || "";
    const groupBy = parseList(by);
    const rows = await getSpCoverage({ ...pickDates(req.query), groupBy });
    res.json(rows);
  } catch (e) {
    console.error("sp/coverage", e);
    res.status(500).json({ error: "sp_coverage_failed" });
  }
});

app.get("/api/sp/inventory", async (req, res) => {
  try {
    const states = parseList(req.query.states);
    const plans = await listSavingsPlans({ states });
    res.json(plans);
  } catch (e) {
    console.error("sp/inventory", e);
    res.status(500).json({ error: "sp_inventory_failed" });
  }
});

app.get("/api/sp/utilization", async (req, res) => {
  try {
    const granularity = String(req.query.granularity || "").toUpperCase() === "MONTHLY" ? "MONTHLY" : "DAILY";
    const data = await getSpUtilization({ ...pickDates(req.query), granularity });
    res.json(data);
  } catch (e) {
    console.error("sp/utilization", e);
    res.status(500).json({ error: "sp_utilization_failed" });
  }
});

app.get("/api/sp/mapping", async (req, res) => {
  try {
    if (isDbOnlyMode()) {
      return sendDbOnly(res, {
        mode: "db_only",
        summary: { plans: 0, totalCommitment: 0, usedCommitment: 0, unusedCommitment: 0, appliedInstances: 0 },
        groups: [],
        uncoveredInstances: [],
        note: "Mapping Savings Plans désactivé en mode DB-only pour éviter les appels AWS."
      });
    }
    let acctList = await resolveAccountsOrDefault(req);
    const requestedAccountIds = parseList(req.query.accounts || req.query.account);
    if (requestedAccountIds.length) {
      const requested = new Set(requestedAccountIds);
      acctList = acctList.filter(account => requested.has(account.accountId || account.id || ""));
    }
    const regions = resolveRegions(req);
    const [instancesRaw, reservations, savingsPlans] = await Promise.all([
      listInstances({ accounts: acctList, regions: regions.length ? regions : undefined }),
      listReservedInstances({ accounts: acctList, regions: regions.length ? regions : undefined }),
      listSavingsPlans({ states: ["active"] })
    ]);

    // Savings Plans target only non-RI capacity for this mapping view.
    const instances = attachRiCoverageToInstances(instancesRaw, reservations)
      .filter(inst => !inst.riCovered);

    const discoveredRegions = new Set();
    const pricingKeysByRegion = new Map();
    for (const inst of instances) {
      const region = String(inst.region || "").trim();
      const instanceType = inst.instanceType || inst.type;
      if (!region || !instanceType) continue;
      discoveredRegions.add(region);
      const key = buildRateKey({
        instanceType,
        operatingSystem: normalizeInstanceOperatingSystem(inst.platform),
        tenancy: normalizeInstanceTenancy(inst.tenancy),
        preInstalledSw: "NA"
      });
      if (!pricingKeysByRegion.has(region)) {
        pricingKeysByRegion.set(region, new Set());
      }
      pricingKeysByRegion.get(region).add(key);
    }

    const pricingByRegion = new Map();
    await Promise.all(Array.from(discoveredRegions).map(async (region) => {
      const keys = pricingKeysByRegion.get(region);
      if (!keys || keys.size === 0) return;
      try {
        const pricing = await getEc2OnDemandPricing(region, { requiredKeys: Array.from(keys) });
        pricingByRegion.set(region, pricing);
      } catch (err) {
        console.error("sp/mapping pricing failed for region", region, err);
      }
    }));

    const mappedItems = instances.map(inst => {
      const region = inst.region || "";
      const instanceType = inst.instanceType || inst.type || "";
      const operatingSystem = normalizeInstanceOperatingSystem(inst.platform);
      const tenancy = normalizeInstanceTenancy(inst.tenancy);
      const rateKey = buildRateKey({ instanceType, operatingSystem, tenancy, preInstalledSw: "NA" });
      const pricingEntry = pricingByRegion.get(region)?.rates?.get(rateKey);
      const onDemandHourly = Number(pricingEntry?.price);
      const family = String(instanceType || "").split(".")[0] || "";
      return {
        accountId: inst.accountId || "",
        instanceId: inst.instanceId || "",
        name: inst.name || inst.instanceName || "",
        instanceType,
        family,
        region,
        platform: inst.platform || inst.PlatformDetails || "",
        availabilityZone: inst.az || inst.availabilityZone || inst.Placement?.AvailabilityZone || "",
        privateIp: inst.privateIp || inst.PrivateIpAddress || "",
        publicIp: inst.publicIp || inst.PublicIpAddress || "",
        launchTime: inst.launchTime || inst.LaunchTime || "",
        state: inst.state || inst.State || "",
        onDemandHourly: Number.isFinite(onDemandHourly) ? onDemandHourly : 0,
        normalizedTenancy: tenancy,
        pricingOperation: pricingEntry?.operation || "",
        pricingUsageType: pricingEntry?.usageType || "",
        hoursPerDay: 24,
        riCovered: false
      };
    });

    const pricingRegions = new Set();
    for (const item of mappedItems) {
      const region = String(item.region || "").trim().toLowerCase();
      if (region) pricingRegions.add(region);
    }
    const pricingCatalogByRegion = new Map();
    await Promise.all(Array.from(pricingRegions).map(async region => {
      try {
        const catalog = await getSavingsPlanCatalog(region);
        if (catalog) pricingCatalogByRegion.set(region, catalog);
      } catch (err) {
        console.error("sp/mapping savings plan pricing fetch failed", region, err);
      }
    }));

    const termCache = new Map();
    const resolvePlanHourlyRate = (plan, item) => {
      const itemRegion = String(item?.region || "").trim().toLowerCase();
      const planRegionRaw = String(plan?.region || plan?.Region || "").trim().toLowerCase();
      const pricingRegion = (!planRegionRaw || planRegionRaw === "any" || planRegionRaw === "global")
        ? itemRegion
        : planRegionRaw;
      if (!pricingRegion) return Number(item?.onDemandHourly || 0);
      const catalog = pricingCatalogByRegion.get(pricingRegion);
      if (!catalog) return Number(item?.onDemandHourly || 0);

      const planIdentity = plan?.id
        || plan?.savingsPlanId
        || plan?.SavingsPlanId
        || plan?.arn
        || plan?.savingsPlanArn
        || plan?.SavingsPlanArn
        || plan?.description
        || plan?.Description
        || "unknown-plan";
      const cacheKey = `${pricingRegion}::${planIdentity}`;
      let term = termCache.get(cacheKey);
      if (term === undefined) {
        term = resolveCatalogTermForPlan(catalog, plan) || null;
        termCache.set(cacheKey, term);
      }
      if (!term) return Number(item?.onDemandHourly || 0);

      const rate = resolveSavingsPlanRateForTerm(term, item);
      if (Number.isFinite(rate) && rate > 0) return rate;
      return Number(item?.onDemandHourly || 0);
    };

    const allocation = applySavingsPlansCoverage(mappedItems, savingsPlans, { resolvePlanHourlyRate });
    const groups = (allocation.planAllocations || []).map((group, idx) => {
      const plan = group.plan || {};
      const planId = plan.id || plan.savingsPlanId || plan.SavingsPlanId || "";
      const planArn = plan.arn || plan.savingsPlanArn || plan.SavingsPlanArn || "";
      return {
        planId,
        arn: planArn,
        description: plan.description || plan.Description || "",
        type: plan.type || plan.savingsPlanType || plan.SavingsPlanType || "",
        paymentOption: plan.paymentOption || plan.PaymentOption || "",
        region: group.region || "any",
        family: group.family || "",
        commitment: Number(group.commitment || 0),
        usedCommitment: Number(group.usedCommitment || 0),
        unusedCommitment: Number(group.unusedCommitment || 0),
        eligibleHourly: Number(group.eligibleHourly || 0),
        coveragePct: Number(group.coveragePct || 0),
        totalInstances: Number(group.eligibleInstancesCount || 0),
        coveredInstancesCount: Number(group.coveredInstancesCount || 0),
        matchedInstances: (Array.isArray(group.matchedInstances) ? group.matchedInstances : []).map(inst => ({
          accountId: inst.accountId || "",
          instanceId: inst.instanceId || "",
          name: inst.name || "",
          instanceType: inst.instanceType || "",
          family: inst.family || (String(inst.instanceType || "").split(".")[0] || ""),
          region: inst.region || "",
          platform: inst.platform || "",
          availabilityZone: inst.availabilityZone || "",
          privateIp: inst.privateIp || "",
          publicIp: inst.publicIp || "",
          state: inst.state || "",
          launchTime: inst.launchTime || "",
          planHourlyRate: Number(inst.planHourlyRate || 0),
          allocatedHourly: Number(inst.allocatedHourly || 0),
          eligibleHourly: Number(inst.eligibleHourly || 0),
          allocatedCoveragePct: Number(inst.allocatedCoveragePct || 0),
        })),
        rowId: planId || planArn || `plan-${idx}`
      };
    });

    const uncoveredInstances = mappedItems
      .filter(inst => Number(inst.spCoveragePct || 0) <= 0)
      .map(inst => ({
        accountId: inst.accountId,
        instanceId: inst.instanceId,
        name: inst.name,
        instanceType: inst.instanceType,
        platform: inst.platform,
        az: inst.availabilityZone,
        privateIp: inst.privateIp,
        publicIp: inst.publicIp,
        launchTime: inst.launchTime,
        state: inst.state,
        region: inst.region,
        onDemandHourly: Number(inst.onDemandHourly || 0),
        spCoveragePct: Number(inst.spCoveragePct || 0),
        spCoveredHourly: Number(inst.spCoveredHourly || 0)
      }));

    res.json({
      mode: allocation.mode,
      summary: {
        plans: allocation.plans,
        totalCommitment: allocation.totalCommitment,
        usedCommitment: allocation.usedCommitment,
        unusedCommitment: allocation.unusedCommitment,
        appliedInstances: allocation.appliedInstances
      },
      groups,
      uncoveredInstances
    });
  } catch (e) {
    console.error("sp/mapping", e);
    res.status(500).json({ error: "sp_mapping_failed" });
  }
});

app.get("/api/coverage/summary", async (req, res) => {
  try {
    const data = await getCoverageSummary(pickDates(req.query));
    res.json(data);
  } catch (e) {
    console.error("coverage/summary", e);
    res.status(500).json({ error: "coverage_summary_failed" });
  }
});

app.get("/api/costs/trends", async (req, res) => {
  try {
    const accounts = parseList(req.query.accounts);
    const regions = parseList(req.query.regions || req.query.region);
    const excludeTax = parseBooleanParam(req.query.excludeTax ?? req.query.exclude_tax, false);
    const data = await getCostTrends({
      ...pickDates(req.query),
      metric: req.query.metric || "UnblendedCost",
      accounts,
      regions,
      excludeTax
    });
    res.json(data);
  } catch (e) {
    console.error("costs/trends", e);
    res.status(500).json({ error: "cost_trends_failed" });
  }
});

app.get("/api/costs/anomalies", async (req, res) => {
  try {
    const accounts = parseList(req.query.accounts);
    const regions = parseList(req.query.regions || req.query.region);
    const excludeTax = parseBooleanParam(req.query.excludeTax ?? req.query.exclude_tax, false);
    const data = await getCostAnomalies({
      ...pickDates(req.query),
      metric: req.query.metric || "UnblendedCost",
      accounts,
      regions,
      excludeTax,
      limit: req.query.limit,
      minAbs: req.query.minAbs ?? req.query.min_abs,
      minPct: req.query.minPct ?? req.query.min_pct
    });
    res.json(data);
  } catch (e) {
    console.error("costs/anomalies", e);
    res.status(500).json({ error: "cost_anomalies_failed" });
  }
});

app.get("/api/costs/breakdown", async (req, res) => {
  try {
    const accounts = parseList(req.query.accounts);
    const regions = parseList(req.query.regions || req.query.region);
    const excludeTax = parseBooleanParam(req.query.excludeTax ?? req.query.exclude_tax, false);
    const data = await getCostBreakdown({
      ...pickDates(req.query),
      metric: req.query.metric || "UnblendedCost",
      accounts,
      regions,
      excludeTax,
      limit: req.query.limit
    });
    res.json(data);
  } catch (e) {
    console.error("costs/breakdown", e);
    res.status(500).json({ error: "cost_breakdown_failed" });
  }
});

app.get("/api/costs/heatmap", async (req, res) => {
  try {
    const accounts = parseList(req.query.accounts);
    const regions = parseList(req.query.regions || req.query.region);
    const excludeTax = parseBooleanParam(req.query.excludeTax ?? req.query.exclude_tax, false);
    const data = await getCostHeatmap({
      ...pickDates(req.query),
      metric: req.query.metric || "UnblendedCost",
      accounts,
      regions,
      excludeTax,
      limit: req.query.limit
    });
    res.json(data);
  } catch (e) {
    console.error("costs/heatmap", e);
    res.status(500).json({ error: "cost_heatmap_failed" });
  }
});

app.get("/api/costs/forecast", async (req, res) => {
  try {
    const accounts = parseList(req.query.accounts);
    const regions = parseList(req.query.regions || req.query.region);
    const excludeTax = parseBooleanParam(req.query.excludeTax ?? req.query.exclude_tax, false);
    const data = await getCostForecast({
      ...pickDates(req.query),
      metric: req.query.metric || "UnblendedCost",
      accounts,
      regions,
      excludeTax,
      limit: req.query.limit,
      anchor: req.query.anchor
    });
    res.json(data);
  } catch (e) {
    console.error("costs/forecast", e);
    res.status(500).json({ error: "cost_forecast_failed" });
  }
});

app.get("/api/insights/actions", async (req, res) => {
  try {
    const accounts = parseList(req.query.accounts);
    const regions = parseList(req.query.regions || req.query.region);
    const excludeTax = parseBooleanParam(req.query.excludeTax ?? req.query.exclude_tax, false);
    const data = await getFinOpsActions({
      ...pickDates(req.query),
      metric: req.query.metric || "UnblendedCost",
      accounts,
      regions,
      excludeTax,
      limit: req.query.limit
    });
    res.json(data);
  } catch (e) {
    console.error("insights/actions", e);
    res.status(500).json({ error: "insights_actions_failed" });
  }
});

app.get("/api/insights/action-states", async (req, res) => {
  try {
    const ids = parseList(req.query.ids || req.query.actionIds || req.query.action_ids);
    const data = await getFinOpsActionStates(ids);
    res.json(data);
  } catch (e) {
    console.error("insights/action-states", e);
    res.status(500).json({ error: "insights_action_states_failed" });
  }
});

app.put("/api/insights/actions/:id/state", async (req, res) => {
  try {
    const data = await setFinOpsActionState(req.params.id, req.body || {});
    res.json(data);
  } catch (e) {
    console.error("insights/actions/state", e);
    res.status(e.status || 500).json({ error: e.message || "insights_action_state_failed" });
  }
});

app.get("/api/insights/drilldown", async (req, res) => {
  try {
    const accounts = parseList(req.query.accounts);
    const regions = parseList(req.query.regions || req.query.region);
    const excludeTax = parseBooleanParam(req.query.excludeTax ?? req.query.exclude_tax, false);
    const data = await getInsightDrilldown({
      ...pickDates(req.query),
      metric: req.query.metric || "UnblendedCost",
      accounts,
      regions,
      excludeTax,
      kind: req.query.kind,
      accountId: req.query.accountId || req.query.account_id,
      service: req.query.service,
      bucket: req.query.bucket,
      region: req.query.region
    });
    res.json(data);
  } catch (e) {
    console.error("insights/drilldown", e);
    res.status(500).json({ error: "insights_drilldown_failed" });
  }
});

app.get("/api/ri/utilization-by", async (req, res) => {
  try {
    const by = req.query.by || req.query.groupBy || "";
    const groupBy = parseList(by);
    const rows = await getRiUtilization({ ...pickDates(req.query), groupBy });
    res.json(rows);
  } catch (e) {
    console.error("ri/utilization-by", e);
    res.status(500).json({ error: "ri_utilization_by_failed" });
  }
});

// ---------- Inventory (EC2/EBS/RI) ----------
app.get("/api/ec2/instances", async (req, res) => {
  try {
    if (isDbOnlyMode()) {
      return sendDbOnly(res, { items: [], note: "Inventaire EC2 désactivé en mode DB-only pour éviter les appels AWS." });
    }
    const acctList = await resolveAccountsOrDefault(req);
    const regions = resolveRegions(req);
    const [instances, reservations] = await Promise.all([
      listInstances({ accounts: acctList, regions: regions.length ? regions : undefined }),
      listReservedInstances({ accounts: acctList, regions: regions.length ? regions : undefined })
    ]);
    const inventory = attachRiCoverageToInstances(instances, reservations);

    const scheduleNames = new Set();
    for (const inst of inventory) {
      const tagValue = getTagValue(inst, "Scheduled_vle") ?? getTagValue(inst, "Scheduled_VLE");
      const scheduleName = tagValue === undefined || tagValue === null ? "" : String(tagValue).trim();
      if (scheduleName) {
        scheduleNames.add(scheduleName);
      }
    }

    const schedules = new Map();
    await Promise.all(Array.from(scheduleNames).map(async scheduleName => {
      try {
        const schedule = await getInstanceSchedule(scheduleName);
        schedules.set(scheduleName, schedule);
      } catch (err) {
        console.error("ec2/instances schedule lookup failed", scheduleName, err);
        schedules.set(scheduleName, null);
      }
    }));

    const items = inventory.map(inst => {
      const tagValue = getTagValue(inst, "Scheduled_vle") ?? getTagValue(inst, "Scheduled_VLE");
      const scheduleName = tagValue === undefined || tagValue === null ? "" : String(tagValue).trim();
      let scheduleSummary = null;

      if (scheduleName) {
        const scheduleInfo = schedules.get(scheduleName);
        if (scheduleInfo) {
          scheduleSummary = {
            name: scheduleInfo.name || scheduleName,
            timezone: scheduleInfo.timezone || null,
            averageDailyHours: Number.isFinite(scheduleInfo.metrics?.averageDailyHours)
              ? scheduleInfo.metrics.averageDailyHours
              : null,
            averageDailyHoursAllDays: Number.isFinite(scheduleInfo.metrics?.averageDailyHoursAllDays)
              ? scheduleInfo.metrics.averageDailyHoursAllDays
              : null,
            totalWeeklyHours: Number.isFinite(scheduleInfo.metrics?.totalMinutesPerWeek)
              ? scheduleInfo.metrics.totalMinutesPerWeek / 60
              : null,
            periods: Array.isArray(scheduleInfo.periods)
              ? scheduleInfo.periods.map(period => ({
                  name: period.name || null,
                  begintime: period.begintime || null,
                  endtime: period.endtime || null,
                  durationHours: Number.isFinite(period.durationHours) ? period.durationHours : null,
                  weekdays: Array.isArray(period.weekdaysExpanded) && period.weekdaysExpanded.length
                    ? period.weekdaysExpanded
                    : period.weekdays || null
                }))
              : []
          };
        } else {
          scheduleSummary = {
            name: scheduleName,
            missing: true
          };
        }
      }

      return {
        ...inst,
        schedule: scheduleSummary
      };
    });

    res.json({ items });
  } catch (e) {
    console.error("ec2/instances", e);
    res.status(500).json({ error: "ec2_instances_failed" });
  }
});

app.get("/api/ec2/snapshots/summary", async (req, res) => {
  try {
    const accounts = parseList(req.query.accounts);
    const regions = parseList(req.query.regions || req.query.region);
    const states = parseList(req.query.states || req.query.state);
    const data = await getEc2SnapshotSummary({
      ...pickDates(req.query),
      accounts,
      regions,
      states
    });
    res.json({ dbOnly: true, source: "db", ...data });
  } catch (e) {
    console.error("ec2/snapshots/summary", e);
    res.status(500).json({ error: "ec2_snapshots_summary_failed" });
  }
});

app.get("/api/ebs/snapshots/summary", async (req, res) => {
  try {
    const accounts = parseList(req.query.accounts);
    const regions = parseList(req.query.regions || req.query.region);
    const volumeTypes = parseList(req.query.volumeTypes || req.query.type);
    const data = await getEbsSnapshotSummary({
      ...pickDates(req.query),
      accounts,
      regions,
      volumeTypes
    });
    res.json({ dbOnly: true, source: "db", ...data });
  } catch (e) {
    console.error("ebs/snapshots/summary", e);
    res.status(500).json({ error: "ebs_snapshots_summary_failed" });
  }
});

app.get("/api/ec2/cost-estimates", async (req, res) => {
  try {
    if (isDbOnlyMode()) {
      return sendDbOnly(res, {
        meta: {
          currency: "USD",
          includeReserved: false,
          mode: "db_only",
          pricing: [],
          savingsPlans: { plans: 0, totalCommitment: 0, usedCommitment: 0, unusedCommitment: 0, appliedInstances: 0, allocationMode: "db_only" }
        },
        items: [],
        note: "Estimations EC2 désactivées en mode DB-only pour éviter EC2, Pricing et DynamoDB."
      });
    }
    const resolvedAccounts = await resolveAccountsOrDefault(req);
    const requestedAccountIds = parseList(req.query.accounts).map(a => String(a));
    const accountMap = new Map(resolvedAccounts.map(acc => [String(acc.accountId), acc]));
    const accounts = requestedAccountIds.length
      ? requestedAccountIds.map(id => accountMap.get(id) || { accountId: id }).filter(Boolean)
      : resolvedAccounts;

    const regions = resolveRegions(req);
    const regionList = regions.length ? regions : [process.env.AWS_REGION || "us-east-1"];

    const mode = String(req.query.mode || "").toLowerCase();
    const includeCandidates = [
      req.query.includeReserved,
      req.query.include_ri,
      req.query.includeRi,
      req.query.includeRI,
      req.query.includeRiCoverage
    ];
    let includeReserved = true;
    for (const candidate of includeCandidates) {
      if (candidate === undefined) continue;
      includeReserved = parseBooleanParam(candidate, includeReserved);
    }
    if (["on_demand", "ondemand", "no-ri", "no_ri", "exclude-reserved", "exclude_reserved"].includes(mode)) {
      includeReserved = false;
    } else if (["ri", "reserved", "effective"].includes(mode)) {
      includeReserved = true;
    }

    const [instances, reservations] = await Promise.all([
      listInstances({ accounts, regions: regionList }),
      listReservedInstances({ accounts: accounts, regions: regionList })
    ]);
    let savingsPlans = [];
    const spMeta = {
      plans: 0,
      totalCommitment: 0,
      usedCommitment: 0,
      unusedCommitment: 0,
      appliedInstances: 0,
      allocationMode: "commitment_aware_hourly",
      error: null
    };
    try {
      savingsPlans = await listSavingsPlans({ states: ["ACTIVE"] });
    } catch (err) {
      console.error("ec2/cost-estimates savingsPlans failed, continuing without SP", err);
      savingsPlans = [];
      spMeta.error = err?.message || "savingsPlans_failed";
    }
    spMeta.plans = Array.isArray(savingsPlans) ? savingsPlans.length : 0;
    spMeta.totalCommitment = (Array.isArray(savingsPlans) ? savingsPlans : []).reduce((s, p) => {
      const val = Number(p.commitment ?? p.Commitment ?? 0) || 0;
      return s + val;
    }, 0);
    const inventory = attachRiCoverageToInstances(instances, reservations);

    const scheduleNames = new Set();
    for (const inst of inventory) {
      const tagValue = getTagValue(inst, "Scheduled_vle") ?? getTagValue(inst, "Scheduled_VLE");
      const scheduleName = tagValue === undefined || tagValue === null ? "" : String(tagValue).trim();
      if (scheduleName) {
        scheduleNames.add(scheduleName);
      }
    }

    const schedules = new Map();
    await Promise.all(Array.from(scheduleNames).map(async scheduleName => {
      try {
        const schedule = await getInstanceSchedule(scheduleName);
        schedules.set(scheduleName, schedule);
      } catch (err) {
        console.error("ec2/cost-estimates schedule lookup failed", scheduleName, err);
        schedules.set(scheduleName, null);
      }
    }));

    const discoveredRegions = new Set(regionList);
    const pricingKeysByRegion = new Map();
    for (const inst of inventory) {
      if (inst?.region) {
        discoveredRegions.add(inst.region);
        const region = inst.region;
        const operatingSystem = normalizeInstanceOperatingSystem(inst.platform);
        const tenancy = normalizeInstanceTenancy(inst.tenancy);
        const key = buildRateKey({
          instanceType: inst.instanceType,
          operatingSystem,
          tenancy,
          preInstalledSw: "NA"
        });
        if (!pricingKeysByRegion.has(region)) {
          pricingKeysByRegion.set(region, new Set());
        }
        pricingKeysByRegion.get(region).add(key);
      }
    }

    const pricingByRegion = new Map();
    const pricingMeta = [];
    await Promise.all(Array.from(discoveredRegions).map(async region => {
      const keys = pricingKeysByRegion.get(region);
      if (!keys || keys.size === 0) {
        pricingMeta.push({ region, skipped: true, reason: "no_matching_instances" });
        return;
      }
      try {
        const pricing = await getEc2OnDemandPricing(region, { requiredKeys: Array.from(keys) });
        pricingByRegion.set(region, pricing);
        pricingMeta.push(pricing.meta);
      } catch (err) {
        console.error("ec2/cost-estimates pricing failed for region", region, err);
        pricingMeta.push({ region, error: err?.name || "pricing_failed", message: err?.message || null });
      }
    }));

    // Precompute items with pricing
    const items = inventory.map(inst => {
      const region = inst.region || "";
      const pricing = pricingByRegion.get(region);
      const operatingSystem = normalizeInstanceOperatingSystem(inst.platform);
      const tenancy = normalizeInstanceTenancy(inst.tenancy);
      const preInstalledSw = "NA";
      const onDemandHourly = pricing?.getPrice({
        instanceType: inst.instanceType,
        operatingSystem,
        tenancy,
        preInstalledSw
      });
      const riCoverageRate = inst?.riCoverage?.effectiveHourlyRate;
      const riEffectiveHourly = Number.isFinite(riCoverageRate)
        ? riCoverageRate
        : (inst.riCovered ? 0 : null);
      const effectiveHourly = deriveEffectiveHourlyRate({
        onDemandHourly,
        riHourly: riEffectiveHourly,
        includeReserved
      });
      const scheduleTag = getTagValue(inst, "Scheduled_vle") ?? getTagValue(inst, "Scheduled_VLE");
      const scheduleName = scheduleTag === undefined || scheduleTag === null ? "" : String(scheduleTag).trim();
      const scheduleInfo = scheduleName ? schedules.get(scheduleName) : null;
      const scheduleDailyHours = resolveScheduleDailyHours(scheduleInfo);
      const appliedDailyHours = Number.isFinite(scheduleDailyHours) && scheduleDailyHours > 0
        ? scheduleDailyHours
        : 24;
      const projections = projectTimeframes(effectiveHourly ?? NaN, { dailyHours: appliedDailyHours });

      let scheduleSummary = null;
      if (scheduleName) {
        if (scheduleInfo) {
          scheduleSummary = {
            name: scheduleInfo.name || scheduleName,
            timezone: scheduleInfo.timezone || null,
            averageDailyHours: Number.isFinite(scheduleInfo.metrics?.averageDailyHours)
              ? scheduleInfo.metrics.averageDailyHours
              : null,
            averageDailyHoursAllDays: Number.isFinite(scheduleInfo.metrics?.averageDailyHoursAllDays)
              ? scheduleInfo.metrics.averageDailyHoursAllDays
              : null,
            totalWeeklyHours: Number.isFinite(scheduleInfo.metrics?.totalMinutesPerWeek)
              ? scheduleInfo.metrics.totalMinutesPerWeek / 60
              : null,
            periods: Array.isArray(scheduleInfo.periods)
              ? scheduleInfo.periods.map(period => ({
                  name: period.name || null,
                  begintime: period.begintime || null,
                  endtime: period.endtime || null,
                  durationHours: Number.isFinite(period.durationHours) ? period.durationHours : null,
                  weekdays: Array.isArray(period.weekdaysExpanded) && period.weekdaysExpanded.length
                    ? period.weekdaysExpanded
                    : period.weekdays || null
                }))
              : []
          };
        } else {
          scheduleSummary = {
            name: scheduleName,
            missing: true
          };
        }
      }

      return {
        accountId: inst.accountId,
        region,
        instanceId: inst.instanceId,
        name: inst.name,
        instanceType: inst.instanceType,
        platform: inst.platform,
        operatingSystem,
        tenancy,
        preInstalledSw,
        state: inst.state,
        riCovered: !!inst.riCovered,
        riCoverage: inst.riCoverage,
        coveragePct: null,
        coverageBool: null,
        spCoveragePct: 0,
        coverageSource: null,
        onDemandHourly,
        riEffectiveHourly,
        effectiveHourly,
        hoursPerDay: appliedDailyHours,
        costDaily: projections.daily,
        costMonthly: projections.monthly,
        costYearly: projections.yearly,
        schedule: scheduleSummary
      };
    });

    const spAllocation = applySavingsPlansCoverage(items, savingsPlans);
    spMeta.appliedInstances = spAllocation.appliedInstances;
    spMeta.usedCommitment = spAllocation.usedCommitment;
    spMeta.unusedCommitment = spAllocation.unusedCommitment;
    spMeta.allocationMode = spAllocation.mode;

    // Normalize coverage fields for downstream UI
    for (const it of items) {
      if (it.riCovered) {
        it.coverageSource = "RI";
        it.coveragePct = null;
        it.coverageBool = true;
      } else if ((it.spCoveragePct || 0) > 0) {
        const pct = Math.min(100, it.spCoveragePct || 0);
        it.coverageSource = "SP";
        it.coveragePct = pct;
        it.coverageBool = true;
      } else {
        it.coverageSource = null;
        it.coveragePct = null;
        it.coverageBool = false;
      }
    }

    const documentation = {
      description: "Estimated EC2 instance costs derived from AWS On-Demand pricing. When includeReserved=true, covered instances report riEffectiveHourly based on their matching reservation and projections exclude On-Demand spend.",
      columns: [
        { key: "accountId", type: "string", description: "AWS account owning the instance" },
        { key: "region", type: "string", description: "Region where the instance runs" },
        { key: "instanceId", type: "string", description: "EC2 Instance identifier" },
        { key: "instanceType", type: "string", description: "Instance type (ex: m5.large)" },
        { key: "operatingSystem", type: "string", description: "Normalized operating system used for pricing lookup" },
        { key: "tenancy", type: "string", description: "Tenancy dimension mapped to AWS Pricing (shared/dedicated/host)" },
        { key: "preInstalledSw", type: "string", description: "AWS Pricing preInstalledSw dimension (NA when unspecified)" },
        { key: "onDemandHourly", type: "number", description: "Published On-Demand hourly rate in USD" },
        { key: "riEffectiveHourly", type: "number|null", description: "Effective hourly cost when RI coverage applies" },
        { key: "effectiveHourly", type: "number|null", description: "Hourly rate selected according to includeReserved/mode" },
        { key: "hoursPerDay", type: "number", description: "Daily hours applied when projecting schedule-adjusted costs" },
        { key: "costDaily", type: "number|null", description: "Projected daily cost based on effective hourly rate" },
        { key: "costMonthly", type: "number|null", description: "Projected monthly cost (30d) based on effective hourly rate" },
        { key: "costYearly", type: "number|null", description: "Projected yearly cost (365d) based on effective hourly rate" },
        { key: "schedule", type: "object|null", description: "Resolved Instance Scheduler configuration attached via Scheduled_vle tag" }
      ]
    };

    res.json({
      meta: {
        currency: "USD",
        includeReserved,
        mode: includeReserved ? "effective" : "on_demand",
        filters: {
          accounts: requestedAccountIds,
          regions: Array.from(discoveredRegions)
        },
        pricing: pricingMeta,
        savingsPlans: spMeta,
        documentation
      },
      items
    });
  } catch (e) {
    console.error("ec2/cost-estimates", e);
    res.status(500).json({ error: "ec2_cost_estimates_failed" });
  }
});

app.get("/api/ebs/volumes", async (req, res) => {
  try {
    if (isDbOnlyMode()) {
      return sendDbOnly(res, { items: [], note: "Inventaire EBS désactivé en mode DB-only pour éviter les appels AWS." });
    }
    let acctList = await resolveAccountsOrDefault(req);
    const requestedAccountIds = parseList(req.query.accounts || req.query.account);
    if (requestedAccountIds.length) {
      const requested = new Set(requestedAccountIds);
      acctList = acctList.filter(account => requested.has(account.accountId || account.id || ""));
    }
    const regions = resolveRegions(req);
    const rawItems = await listVolumes({ accounts: acctList, regions: regions.length ? regions : undefined });
    const { items, pricing } = await addEbsCostEstimates(rawItems);
    res.json({
      meta: {
        currency: "USD",
        pricing,
        documentation: {
          description: "Estimated EBS monthly costs from provisioned storage plus provisioned IOPS/throughput when billable. Snapshot storage and magnetic I/O request usage are not included."
        }
      },
      items
    });
  } catch (e) {
    console.error("ebs/volumes", e);
    res.status(500).json({ error: "ebs_volumes_failed" });
  }
});

app.get("/api/ri/reservations", async (req, res) => {
  try {
    if (isDbOnlyMode()) {
      return sendDbOnly(res, { items: [], note: "Inventaire RI désactivé en mode DB-only pour éviter les appels EC2." });
    }
    const acctList = await resolveAccountsOrDefault(req);
    const regions = resolveRegions(req);
    const items = await listReservedInstances({ accounts: acctList, regions: regions.length ? regions : undefined });
    res.json({ items });
  } catch (e) {
    console.error("ri/reservations", e);
    res.status(500).json({ error: "ri_reservations_failed" });
  }
});

app.get("/api/ri/mapping", async (req, res) => {
  try {
    if (isDbOnlyMode()) {
      return sendDbOnly(res, {
        reservations: [],
        uncoveredInstances: [],
        note: "Mapping RI désactivé en mode DB-only pour éviter les appels EC2."
      });
    }
    const acctList = await resolveAccountsOrDefault(req);
    const regions = resolveRegions(req);
    const [instances, reservations] = await Promise.all([
      listInstances({ accounts: acctList, regions: regions.length ? regions : undefined }),
      listReservedInstances({ accounts: acctList, regions: regions.length ? regions : undefined })
    ]);
    const { reservationsWithMatches, uncoveredInstances } = matchInstancesAndReservations(instances, reservations);
    res.json({ reservations: reservationsWithMatches, uncoveredInstances });
  } catch (e) {
    console.error("ri/mapping", e);
    res.status(500).json({ error: "ri_mapping_failed" });
  }
});

app.get("/api/debug/inventory", async (req, res) => {
  try {
    if (isDbOnlyMode()) {
      return sendDbOnly(res, {
        instances: { count: 0, sample: [] },
        volumes: { count: 0, sample: [] },
        reservations: { count: 0, sample: [] },
        note: "Debug inventaire désactivé en mode DB-only."
      });
    }
    const acctList = await resolveAccountsOrDefault(req);
    const regions = resolveRegions(req);
    const [inst, vols, ris] = await Promise.all([
      listInstances({ accounts: acctList, regions: regions.length ? regions : undefined }),
      listVolumes({ accounts: acctList, regions: regions.length ? regions : undefined }),
      listReservedInstances({ accounts: acctList, regions: regions.length ? regions : undefined }),
    ]);
    res.json({
      instances: { count: inst.length, sample: inst.slice(0, 5) },
      volumes: { count: vols.length, sample: vols.slice(0, 5) },
      reservations: { count: ris.length, sample: ris.slice(0, 5) }
    });
  } catch (e) {
    console.error("debug/inventory", e);
    res.status(500).json({ error: "debug_inventory_failed" });
  }
});

app.get("/api/debug/scheduler", async (req, res) => {
  try {
    if (isDbOnlyMode()) {
      return sendDbOnly(res, {
        scheduleName: String(req.query?.schedule || "").trim(),
        schedule: null,
        regions: resolveRegions(req),
        accounts: (await resolveAccountsOrDefault(req)).map(acc => ({ accountId: acc.accountId || null, hasKey: false })),
        note: "Debug scheduler désactivé en mode DB-only pour éviter DynamoDB."
      });
    }
    const scheduleName = String(req.query?.schedule || "").trim();
    const regions = resolveRegions(req);
    const accounts = await resolveAccountsOrDefault(req);

    const accountSummaries = accounts.map(acc => ({
      accountId: acc?.accountId || null,
      hasKey: !!acc?.accessKeyId
    }));

    const scanAllTables = parseBooleanParam(
      req.query?.scanAllTables
        ?? req.query?.scan_all_tables
        ?? req.query?.scanTables
        ?? req.query?.scan_tables
        ?? req.query?.scan,
      false
    );
    const maxTablesCandidate = Number.parseInt(
      req.query?.maxTables ?? req.query?.max_tables ?? "",
      10
    );
    const maxTables = Number.isFinite(maxTablesCandidate) && maxTablesCandidate > 0
      ? maxTablesCandidate
      : undefined;
    const includeRawItems = parseBooleanParam(
      req.query?.includeRaw ?? req.query?.include_raw ?? req.query?.raw,
      false
    );

    if (!scheduleName) {
      return res.status(400).json({
        error: "missing_schedule_parameter",
        schedule: null,
        scheduleName,
        regions,
        accounts: accountSummaries
      });
    }

    try {
      const schedule = await getInstanceSchedule(scheduleName);
      const responseBody = {
        scheduleName,
        schedule,
        regions,
        accounts: accountSummaries
      };
      if (scanAllTables) {
        responseBody.debug = await debugInstanceScheduleSearch(scheduleName, {
          maxTables,
          includeRawItems
        });
      }
      return res.json(responseBody);
    } catch (err) {
      console.error("debug/scheduler", scheduleName, err);
      const errorBody = {
        error: {
          name: err?.name || "Error",
          message: err?.message || String(err)
        },
        scheduleName,
        schedule: null,
        regions,
        accounts: accountSummaries
      };
      if (scanAllTables) {
        try {
          errorBody.debug = await debugInstanceScheduleSearch(scheduleName, {
            maxTables,
            includeRawItems
          });
        } catch (debugErr) {
          errorBody.debugError = {
            name: debugErr?.name || "Error",
            message: debugErr?.message || String(debugErr)
          };
        }
      }
      return res.status(500).json(errorBody);
    }
  } catch (e) {
    console.error("debug/scheduler", e);
    res.status(500).json({ error: "debug_scheduler_failed" });
  }
});

const PORT = process.env.PORT || 8081;


// Basic AWS debug endpoint to verify credentials and regional access


app.get("/api/debug/accounts", async (req, res) => {
  try {
    const { path: configPath, config } = loadAccountsConfig();
    const stat = Array.isArray(config?.static) ? config.static : [];
    const assumeRoles = Array.isArray(config?.assumeRoles) ? config.assumeRoles : [];
    const mask = (k)=> k ? String(k).slice(-4) : null;
    const out = stat.map(a => ({
      accountId: String(a.accountId||""),
      accountName: a.accountName || null,
      type: "static",
      accessKeyIdLast4: mask(a.accessKeyId),
      hasSecret: !!a.secretAccessKey
    })).concat(assumeRoles.map(a => ({
      accountId: String(a.accountId||""),
      accountName: a.accountName || null,
      type: "assumeRole",
      roleArn: a.roleArn,
      externalId: a.externalId ? "***" : null
    })));
    res.json({ configPath: configPath || null, count: out.length, accounts: out });
  } catch (e) {
    console.error("debug/accounts", e);
    res.status(500).json({ error: "debug_accounts_failed" });
  }
});



// Deep probe per account+region to validate credentials and rights
app.get("/api/debug/ec2-matrix", async (req, res) => {
  try {
    if (isDbOnlyMode()) {
      return sendDbOnly(res, {
        regions: resolveRegions(req),
        accounts: (await resolveAccountsOrDefault(req)).map(a => ({ accountId: a.accountId, hasKey: false })),
        results: [],
        note: "Debug EC2 désactivé en mode DB-only."
      });
    }
    const acctList = await resolveAccountsOrDefault(req);
    const regions = resolveRegions(req);
    const results = [];
    for (const acct of acctList){
      for (const region of regions){
        const r = { accountId: acct.accountId || "unknown", region, ok: true, counts:{}, errors:{} };
        try {
          const client = new EC2Client({ region, credentials: acct.accessKeyId ? { accessKeyId: acct.accessKeyId, secretAccessKey: acct.secretAccessKey, sessionToken: acct.sessionToken || undefined } : undefined });
          // Instances
          try {
            let total = 0, NextToken;
            do {
              const out = await client.send(new DescribeInstancesCommand({ NextToken }));
              const resv = out?.Reservations || [];
              for (const rr of resv) total += (rr.Instances || []).length;
              NextToken = out?.NextToken;
            } while (NextToken);
            r.counts.instances = total;
          } catch (e) {
            r.ok = false; r.errors.instances = { name: e?.name || "Error", message: e?.message || String(e) };
          }
          // Volumes
          try {
            let total = 0, NextToken;
            do {
              const out = await client.send(new DescribeVolumesCommand({ NextToken }));
              total += (out?.Volumes || []).length;
              NextToken = out?.NextToken;
            } while (NextToken);
            r.counts.volumes = total;
          } catch (e) {
            r.ok = false; r.errors.volumes = { name: e?.name || "Error", message: e?.message || String(e) };
          }
          // Reserved Instances
          try {
            let total = 0, NextToken;
            do {
              const out = await client.send(new DescribeReservedInstancesCommand({ NextToken }));
              total += (out?.ReservedInstances || []).length;
              NextToken = out?.NextToken;
            } while (NextToken);
            r.counts.reservations = total;
          } catch (e) {
            r.ok = false; r.errors.reservations = { name: e?.name || "Error", message: e?.message || String(e) };
          }
        } catch (e) {
          r.ok = false; r.errors.client = { name: e?.name || "Error", message: e?.message || String(e) };
        }
        results.push(r);
      }
    }
    res.json({ regions, accounts: acctList.map(a=>({accountId:a.accountId, hasKey: !!a.accessKeyId})), results });
  } catch (e) {
    console.error("debug/ec2-matrix", e);
    res.status(500).json({ error: "debug_ec2_matrix_failed" });
  }
});


// Simple identity endpoint for the default credential chain
app.get("/api/debug/identity", async (req, res) => {
  try {
    if (isDbOnlyMode()) {
      return sendDbOnly(res, {
        account: null,
        userId: null,
        arn: null,
        region: resolveRegions(req)[0] || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || null,
        note: "STS désactivé en mode DB-only."
      });
    }
    const regions = resolveRegions(req);
    const region = regions[0] || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
    try {
      const sts = new STSClient({ region });
      const out = await sts.send(new GetCallerIdentityCommand({}));
      return res.json({ account: out?.Account || null, userId: out?.UserId || null, arn: out?.Arn || null, region });
    } catch (e) {
      return res.status(500).json({ error: { name: e?.name || "Error", message: e?.message || String(e) } });
    }
  } catch (e) {
    console.error("debug/identity", e);
    res.status(500).json({ error: "debug_identity_failed" });
  }
});

app.get("/api/debug/aws", async (req, res) => {
  try {
    if (isDbOnlyMode()) {
      const runtime = await getDbRuntimeStatus();
      const regionsEnv = parseList(process.env.EC2_REGIONS || "");
      const configuredRegion = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || null;
      const regionsEffective = runtime.regions.length
        ? runtime.regions
        : (regionsEnv.length ? regionsEnv : (configuredRegion ? [configuredRegion] : []));
      return sendDbOnly(res, {
        env: {
          hasAccessKeyId: false,
          accessKeyIdLast4: null,
          hasSecretAccessKey: false,
          hasSessionToken: false,
          profile: null,
          sdkLoadConfig: process.env.AWS_SDK_LOAD_CONFIG || null,
          awsRegionEnv: configuredRegion,
          ec2RegionsEnv: regionsEnv
        },
        identity: null,
        idError: null,
        discoveredRegions: runtime.regions,
        regionsEffective,
        regionsError: null,
        probes: [],
        accounts: runtime.accounts.map(accountId => ({ accountId, accessKeyIdLast4: null })),
        note: "Endpoint rendu DB-only: aucun appel STS/EC2 n'a été effectué."
      });
    }
    const regionsEnv = parseList(process.env.EC2_REGIONS || "") || [];
    const defaultRegion = regionsEnv[0] || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";

    // Identity via STS
    let identity = null, idError = null;
    try {
      const sts = new STSClient({ region: defaultRegion });
      const out = await sts.send(new GetCallerIdentityCommand({}));
      identity = { account: out?.Account || null, userId: out?.UserId || null, arn: out?.Arn || null };
    } catch (e) {
      idError = { name: e?.name || "Error", message: e?.message || String(e) };
    }

    // Discover regions (best-effort)
    let discoveredRegions = [], regionsError = null;
    try {
      const ec2 = new EC2Client({ region: defaultRegion });
      const out = await ec2.send(new DescribeRegionsCommand({ AllRegions: true }));
      discoveredRegions = (out?.Regions || []).map(r => r.RegionName).filter(Boolean);
    } catch (e) {
      regionsError = { name: e?.name || "Error", message: e?.message || String(e) };
    }

    // Effective regions for this request
    const regionsEffective = resolveRegions(req);

    // Probe a small set of regions
    const regionsToProbe = regionsEnv.length ? regionsEnv : (discoveredRegions.length ? discoveredRegions.slice(0, 6) : [defaultRegion]);
    const probes = [];
    for (const region of regionsToProbe) {
      const probe = { region, ok: true, counts: {}, errors: {} };
      try {
        const ec2 = new EC2Client({ region });
        // Instances
        try {
          let total = 0, NextToken;
          do {
            const out = await ec2.send(new DescribeInstancesCommand({ NextToken }));
            const res = out?.Reservations || [];
            for (const r of res) total += (r.Instances || []).length;
            NextToken = out?.NextToken;
          } while (NextToken);
          probe.counts.instances = total;
        } catch (e) {
          probe.ok = false;
          probe.errors.instances = { name: e?.name || "Error", message: e?.message || String(e) };
        }
        // Volumes
        try {
          let total = 0, NextToken;
          do {
            const out = await ec2.send(new DescribeVolumesCommand({ NextToken }));
            total += (out?.Volumes || []).length;
            NextToken = out?.NextToken;
          } while (NextToken);
          probe.counts.volumes = total;
        } catch (e) {
          probe.ok = false;
          probe.errors.volumes = { name: e?.name || "Error", message: e?.message || String(e) };
        }
        // Reserved Instances
        try {
          let total = 0, NextToken;
          do {
            const out = await ec2.send(new DescribeReservedInstancesCommand({ NextToken }));
            total += (out?.ReservedInstances || []).length;
            NextToken = out?.NextToken;
          } while (NextToken);
          probe.counts.reservations = total;
        } catch (e) {
          probe.ok = false;
          probe.errors.reservations = { name: e?.name || "Error", message: e?.message || String(e) };
        }
      } catch (e) {
        probe.ok = false;
        probe.errors.client = { name: e?.name || "Error", message: e?.message || String(e) };
      }
      probes.push(probe);
    }

    res.json({
      env: {
        hasAccessKeyId: !!process.env.AWS_ACCESS_KEY_ID,
        accessKeyIdLast4: process.env.AWS_ACCESS_KEY_ID ? String(process.env.AWS_ACCESS_KEY_ID).slice(-4) : null,
        hasSecretAccessKey: !!process.env.AWS_SECRET_ACCESS_KEY,
        hasSessionToken: !!process.env.AWS_SESSION_TOKEN,
        profile: process.env.AWS_PROFILE || null,
        sdkLoadConfig: process.env.AWS_SDK_LOAD_CONFIG || null,
        awsRegionEnv: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || null,
        ec2RegionsEnv: (process.env.EC2_REGIONS || "").split(",").map(s=>s.trim()).filter(Boolean)
      },
      identity,
      idError,
      discoveredRegions,
      regionsEffective,
      regionsError,
      probes,
      accounts: (loadAccountsConfig().config?.static || []).map(a => ({
        accountId: String(a.accountId || ""),
        accessKeyIdLast4: a.accessKeyId ? String(a.accessKeyId).slice(-4) : null
      }))
    });
  } catch (e) {
    console.error("debug/aws", e);
    res.status(500).json({ error: "debug_aws_failed" });
  }
});


// ---------- S3 ----------

const S3_BUCKETS_CACHE_TTL_MS = Math.max(30000, Number.parseInt(process.env.S3_BUCKETS_CACHE_TTL_MS || "300000", 10) || 300000);
const S3_PREFER_DB = __DATA_FROM_FLAG === "LOCAL_DB" || __DATA_FROM_FLAG === "DB";
const S3_ALLOW_LIVE = __DATA_FROM_FLAG !== "LOCAL_DB";
const s3BucketsCache = new Map();

function buildS3CacheKey(accounts, regions){
  const accountIds = Array.isArray(accounts) ? accounts.map(a => {
    if (!a) return null;
    if (typeof a === "string") return a;
    if (typeof a === "object" && a.accountId) return String(a.accountId);
    return null;
  }).filter(Boolean) : [];
  accountIds.sort();
  const regionList = Array.isArray(regions) ? regions.filter(Boolean) : [];
  regionList.sort();
  return JSON.stringify({ accounts: accountIds, regions: regionList });
}

function normalizeDbClasses(raw){
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw)){
    out[k] = Number(v || 0);
  }
  return out;
}

async function loadBucketsFromDb({ accounts, regions }){
  const rows = await getS3LatestSnapshot({ accounts, regions });
  if (!rows || rows.length === 0) return null;
  let asOf = null;
  const items = rows.map(row => {
    const snapshotDay = dbDateToIso(row.day);
    if (snapshotDay && (!asOf || snapshotDay > asOf)) asOf = snapshotDay;
    return {
      accountId: String(row.account_id || row.accountId || "unknown"),
      bucket: row.bucket,
      region: row.region,
      createdAt: null,
      totalBytes: Number(row.bytes_total ?? row.bytesTotal ?? 0),
      objects: Number(row.objects_total ?? row.objectsTotal ?? 0),
      classes: normalizeDbClasses(row.bytes_by_class || row.classes || {}),
      tags: {},
      snapshotDay
    };
  });
  items.sort((a,b)=> (b.totalBytes||0) - (a.totalBytes||0));
  return {
    items,
    cached: true,
    source: "db",
    asOf,
    retrievedAt: new Date().toISOString()
  };
}

async function getS3BucketsPayload({ accounts, regions, forceLive = false, forceRefresh = false }){
  const effectiveForceLive = forceLive && S3_ALLOW_LIVE && !isDbOnlyMode();
  const key = buildS3CacheKey(accounts, regions);
  const now = Date.now();
  if (!forceRefresh){
    const entry = s3BucketsCache.get(key);
    if (entry && entry.payload && entry.expiresAt && entry.expiresAt > now){
      return entry.payload;
    }
    if (entry && entry.promise){
      return entry.promise;
    }
    if (entry && entry.expiresAt && entry.expiresAt <= now){
      s3BucketsCache.delete(key);
    }
  } else {
    s3BucketsCache.delete(key);
  }

  const fetchPromise = (async () => {
    try {
      if (!effectiveForceLive){
        try {
          const snapshot = await loadBucketsFromDb({ accounts, regions });
          if (snapshot){
            const payload = { ...snapshot };
            s3BucketsCache.set(key, { payload, expiresAt: Date.now() + S3_BUCKETS_CACHE_TTL_MS });
            return payload;
          }
          if (S3_PREFER_DB){
            console.warn("s3/buckets", "no cached snapshot available, falling back to live API");
          }
        } catch (dbErr){
          if (S3_PREFER_DB){
            console.error("s3/buckets", "failed to load cached snapshot", dbErr);
          }
        }
      }

      if (!S3_ALLOW_LIVE){
        const payload = { items: [], cached: true, source: "db", asOf: null, retrievedAt: new Date().toISOString() };
        s3BucketsCache.set(key, { payload, expiresAt: Date.now() + S3_BUCKETS_CACHE_TTL_MS });
        return payload;
      }

      const liveItems = await listS3Buckets({ accounts, regions: regions && regions.length ? regions : undefined });
      const payload = {
        items: liveItems,
        cached: false,
        source: "live",
        fetchedAt: new Date().toISOString()
      };
      s3BucketsCache.set(key, { payload, expiresAt: Date.now() + S3_BUCKETS_CACHE_TTL_MS });
      return payload;
    } catch (err){
      s3BucketsCache.delete(key);
      throw err;
    }
  })();

  s3BucketsCache.set(key, { promise: fetchPromise });
  return fetchPromise;
}

app.get("/api/s3/pricing", async (req, res) => {
  try {
    const { region } = req.query;
    if (!region) return res.status(400).json({ error: "missing_region" });
    const table = await getS3PricingTable(region);
    res.json(table);
  } catch (e) {
    console.error("s3/pricing", e);
    res.status(500).json({ error: "s3_pricing_failed" });
  }
});

app.get("/api/s3/buckets", async (req, res) => {
  try {
    const acctList = await resolveAccountsOrDefault(req);
    const regions = resolveRegions(req);
    const forceRefresh = String(req.query.fresh || "").toLowerCase() === "1";
    const forceLive = String(req.query.live || "").toLowerCase() === "1";
    const payload = await getS3BucketsPayload({
      accounts: acctList,
      regions,
      forceLive,
      forceRefresh
    });

    res.json(payload);
  } catch (e) {
    console.error("s3/buckets", e);
    res.status(500).json({ error: "s3_buckets_failed" });
  }
});

app.get("/api/s3/bucket-ts", async (req, res) => {
  try {
    const { bucket, region, start, end, cached } = req.query;
    if (!bucket || !region || !start || !end) return res.status(400).json({ error: "missing_params" });
    const useCached = String(cached||"").toLowerCase()==="1" || ["DB", "LOCAL_DB"].includes(__DATA_FROM_FLAG);
    if (useCached){
      const rows = await query(
        `select day, bytes_total, objects_total, bytes_by_class
         from s3_bucket_daily
         where bucket = $1 and region = $2 and day >= $3::date and day < $4::date
         order by day asc`,
        [bucket, region, start, end]
      );
      const series = [];
      const objectsSeries = [];
      const seriesByClass = {};
      for (const r of rows.rows){
        const t = dbDateToIso(r.day);
        const total = Number(r.bytes_total||0);
        const obj = Number(r.objects_total||0);
        series.push({ t, bytes: total });
        objectsSeries.push({ t, objects: obj });
        const classes = normalizeDbClasses(r.bytes_by_class || {});
        for (const [k, v] of Object.entries(classes)){
          if (!seriesByClass[k]) seriesByClass[k] = [];
          seriesByClass[k].push({ t, bytes: Number(v||0) });
        }
      }
      const latest = rows.rows[rows.rows.length-1] || null;
      const classes = latest ? normalizeDbClasses(latest.bytes_by_class || {}) : {};
      const objects = latest ? Number(latest.objects_total||0) : 0;
      return res.json({ series, seriesByClass, objectsSeries, classes, objects, /* v1.7 cached S3 */ cached: true });
    }
    // fallback to live
    const acctList = await resolveAccountsOrDefault(req);
    let data = null;
    for (const acc of acctList){
      try {
        data = await getBucketTimeseries({ account: acc, bucket, region, start, end });
        if (data && data.series && data.series.length) break;
      } catch {}
    }
    res.json(data || { series: [], objectsSeries: [], classes: {}, objects: 0 });
  } catch (e) {
    console.error("s3/bucket-ts", e);
    res.status(500).json({ error: "s3_bucket_ts_failed" });
  }
});

app.get("/api/s3/bucket-cost", async (req, res) => {
  try {
    const { bucket, region, start, end } = req.query;
    if (!bucket || !region || !start || !end) {
      return res.status(400).json({ error: "missing_params" });
    }
    if (isDbOnlyMode()) {
      const rows = await getS3SeriesFromDb({ accountId: null, region, bucket, start, end });
      const table = await getS3PricingTable(region);
      const prices = table?.prices || {};
      const currency = table?.currency || "USD";
      const denom = 30.44;
      const byClass = {};
      let totalUSD = 0;
      for (const row of rows || []) {
        const classes = normalizeDbClasses(row.bytes_by_class || {});
        for (const [cls, bytes] of Object.entries(classes)) {
          const gbDays = Number(bytes || 0) / (1024 * 1024 * 1024);
          if (!byClass[cls]) byClass[cls] = { gbMonth: 0, price: Number(prices[cls] || 0), cost: 0 };
          byClass[cls].gbMonth += gbDays / denom;
        }
      }
      for (const item of Object.values(byClass)) {
        item.cost = item.gbMonth * item.price;
        totalUSD += item.cost;
      }
      return res.json({ bucket, region, start, end, currency, totalUSD, byClass, days: rows.length, cached: true, source: "db" });
    }
    // Fetch bucket timeseries (bytes per class per day)
    const acctList = await resolveAccountsOrDefault(req);
    let ts = null;
    for (const acc of acctList) {
      try {
        ts = await getBucketTimeseries({ account: acc, bucket, region, start, end });
        if (ts && ts.series && ts.series.length) break;
      } catch {}
    }
    const seriesByClass = (ts && ts.seriesByClass) ? ts.seriesByClass : {};
    const days = (ts && Array.isArray(ts.series)) ? ts.series.length : 0;

    // Fetch pricing per storage class for the region
    const table = await getS3PricingTable(region);
    const prices = (table && table.prices) ? table.prices : {};
    const currency = (table && table.currency) ? table.currency : "USD";

    const denom = 30.44; // convert GB-days to GB-months
    const byClass = {};
    let totalUSD = 0;

    for (const cls of Object.keys(seriesByClass)) {
      const arr = Array.isArray(seriesByClass[cls]) ? seriesByClass[cls] : [];
      // Sum GB-days
      let gbDays = 0;
      for (const p of arr) {
        const bytes = Number(p && p.bytes ? p.bytes : 0);
        gbDays += bytes / (1024 * 1024 * 1024);
      }
      const gbMonth = gbDays / denom;
      const price = Number(prices[cls] || 0);
      const cost = gbMonth * price;
      byClass[cls] = { gbMonth, price, cost };
      totalUSD += cost;
    }

    res.json({ bucket, region, start, end, currency, totalUSD, byClass, days });
  } catch (e) {
    console.error("s3/bucket-cost", e);
    res.status(500).json({ error: "s3_bucket_cost_failed" });
  }
});

app.get("/api/s3/bucket-ts-cached", async (req, res) => {
  try {
    const { accountId=null, bucket, region, start, end } = req.query;
    if (!bucket || !region || !start || !end) return res.status(400).json({ error: "missing_params" });
    const rows = await getS3SeriesFromDb({ accountId: accountId||null, region, bucket, start, end });
    res.json({ items: rows });
  } catch (e) {
    console.error("s3/bucket-ts-cached", e);
    res.status(500).json({ error: "s3_bucket_ts_cached_failed" });
  }
});

app.get("/api/s3/growth", async (req, res) => {
  try {
    const accounts = parseList(req.query.accounts);
    const regions = parseList(req.query.regions || req.query.region);
    const data = await getS3Growth({
      ...pickDates(req.query),
      accounts,
      regions,
      limit: req.query.limit
    });
    res.json(data);
  } catch (e) {
    console.error("s3/growth", e);
    res.status(500).json({ error: "s3_growth_failed" });
  }
});
app.listen(PORT, () => {
  console.log(`API listening on :${PORT}`);
});

// ---------- VPC / Réseau ----------
app.get("/api/network/vpc-inventory", async (req, res) => {
  try {
    if (isDbOnlyMode()) return sendDbOnly(res, { items: [], note: "Inventaire réseau désactivé en mode DB-only pour éviter les appels EC2/ELB." });
    const acctList = await resolveAccountsOrDefault(req);
    const regions = resolveRegions(req);
    const items = await listVpcs({ accounts: acctList, regions: regions.length ? regions : undefined });
    res.json({ items });
  } catch (e) {
    console.error("network/vpc-inventory", e);
    res.status(500).json({ error: "vpc_inventory_failed" });
  }
});
app.get("/api/network/load-balancers", async (req, res) => {
  try {
    if (isDbOnlyMode()) return sendDbOnly(res, { items: [], note: "Inventaire load balancers désactivé en mode DB-only pour éviter les appels ELB." });
    const acctList = await resolveAccountsOrDefault(req);
    const regions = resolveRegions(req);
    const items = await listLoadBalancers({ accounts: acctList, regions: regions.length ? regions : undefined });
    res.json({ items });
  } catch (e) {
    console.error("network/load-balancers", e);
    res.status(500).json({ error: "load_balancers_failed" });
  }
});
app.get("/api/network/tgw/attachments", async (req, res) => {
  try {
    if (isDbOnlyMode()) return sendDbOnly(res, { items: [], note: "Inventaire TGW désactivé en mode DB-only pour éviter les appels EC2." });
    const acctList = await resolveAccountsOrDefault(req);
    const regions = resolveRegions(req);
    const items = await listTransitGatewayAttachments({ accounts: acctList, regions: regions.length ? regions : undefined });
    res.json({ items });
  } catch (e) {
    console.error("network/tgw/attachments", e);
    res.status(500).json({ error: "tgw_attachments_failed" });
  }
});
app.get("/api/network/peering", async (req, res) => {
  try {
    if (isDbOnlyMode()) return sendDbOnly(res, { items: [], note: "Inventaire peering désactivé en mode DB-only pour éviter les appels EC2." });
    const acctList = await resolveAccountsOrDefault(req);
    const regions = resolveRegions(req);
    const items = await listVpcPeeringConnections({ accounts: acctList, regions: regions.length ? regions : undefined });
    res.json({ items });
  } catch (e) {
    console.error("network/peering", e);
    res.status(500).json({ error: "vpc_peering_failed" });
  }
});
app.get("/api/network/endpoints", async (req, res) => {
  try {
    if (isDbOnlyMode()) return sendDbOnly(res, { items: [], note: "Inventaire endpoints désactivé en mode DB-only pour éviter les appels EC2." });
    const acctList = await resolveAccountsOrDefault(req);
    const regions = resolveRegions(req);
    const items = await listVpcEndpoints({ accounts: acctList, regions: regions.length ? regions : undefined });
    res.json({ items });
  } catch (e) {
    console.error("network/endpoints", e);
    res.status(500).json({ error: "vpc_endpoints_failed" });
  }
});
app.get("/api/network/nat", async (req, res) => {
  try {
    if (isDbOnlyMode()) return sendDbOnly(res, { items: [], note: "Inventaire NAT désactivé en mode DB-only pour éviter les appels EC2." });
    const acctList = await resolveAccountsOrDefault(req);
    const regions = resolveRegions(req);
    const items = await listNatGateways({ accounts: acctList, regions: regions.length ? regions : undefined });
    res.json({ items });
  } catch (e) {
    console.error("network/nat", e);
    res.status(500).json({ error: "nat_failed" });
  }
});
app.get("/api/network/interfaces", async (req, res) => {
  try {
    if (isDbOnlyMode()) return sendDbOnly(res, { items: [], note: "Inventaire interfaces réseau désactivé en mode DB-only pour éviter les appels EC2." });
    const acctList = await resolveAccountsOrDefault(req);
    const regions = resolveRegions(req);
    const items = await listNetworkInterfaces({ accounts: acctList, regions: regions.length ? regions : undefined });
    res.json({ items });
  } catch (e) {
    console.error("network/interfaces", e);
    res.status(500).json({ error: "network_interfaces_failed" });
  }
});

app.get("/api/network/finops", async (req, res) => {
  try {
    if (isDbOnlyMode()) {
      return sendDbOnly(res, {
        summary: { resources: 0, totalMonthlyCost: 0, potentialMonthlySavings: 0, idleResources: 0, unknownUsage: 0, byType: [], byAccount: [] },
        items: [],
        note: "Network FinOps désactivé en mode DB-only pour éviter les appels EC2/ELB/CloudWatch."
      });
    }
    let acctList = await resolveAccountsOrDefault(req);
    const requestedAccountIds = parseList(req.query.accounts || req.query.account);
    if (requestedAccountIds.length) {
      const requested = new Set(requestedAccountIds);
      acctList = acctList.filter(account => requested.has(account.accountId || account.id || ""));
    }
    const regions = resolveRegions(req);
    const { start, end } = pickDates(req.query);
    const days = Number.parseInt(String(req.query.days || "30"), 10) || 30;
    const includeMetrics = !["0", "false", "no"].includes(String(req.query.includeMetrics || "1").toLowerCase());
    const forceRefresh = ["1", "true", "yes"].includes(String(req.query.forceRefresh || "").toLowerCase());
    const accountIds = acctList.map(a => a.accountId || a.id || "").filter(Boolean).sort();
    const regionList = (regions.length ? regions : []).slice().sort();
    const cacheKey = [
      "network-finops:v1",
      accountIds.join(",") || "default",
      regionList.join(",") || "default",
      start || "",
      end || "",
      String(days),
      includeMetrics ? "metrics" : "inventory"
    ].join(":");
    const ttlSeconds = Number.parseInt(String(process.env.NETWORK_FINOPS_CACHE_TTL_SECONDS || "1800"), 10) || 1800;
    const { value, meta } = await getOrSetAwsCache({
      cacheKey,
      ttlSeconds,
      forceRefresh,
      fetcher: () => getNetworkFinOps({
        accounts: acctList,
        regions: regions.length ? regions : [process.env.AWS_REGION || "eu-west-3"],
        start,
        end,
        days,
        includeMetrics
      })
    });
    res.json({ ...value, cache: meta });
  } catch (e) {
    console.error("network/finops", e);
    res.status(500).json({ error: "network_finops_failed" });
  }
});



// --- diagnostics: data source (DB vs AWS API) ---
try {
  console.log(`[API] DATA_FROM=${__DATA_FROM_FLAG}, DB_ONLY=${isDbOnlyMode() ? "true" : "false"} => ${isDbOnlyMode() ? "Reading from Postgres and blocking live AWS read paths" : "Live AWS read paths allowed"}`);
} catch {}

app.get("/api/meta/source", (req, res) => {
  const dataFrom = String(process.env.DATA_FROM || process.env.data_from || "LOCAL_DB").toUpperCase();
  res.json({ dataFrom, dbOnly: isDbOnlyMode(), awsLiveAllowed: __AWS_LIVE_ENABLED });
});

app.get("/api/meta/runtime", async (req, res) => {
  try {
    const runtime = await getDbRuntimeStatus();
    const envRegions = parseList(process.env.EC2_REGIONS || "");
    const configuredRegion = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || null;
    const regionsEffective = runtime.regions.length
      ? runtime.regions
      : (envRegions.length ? envRegions : (configuredRegion ? [configuredRegion] : []));
    res.json({
      dataFrom: __DATA_FROM_FLAG,
      dbOnly: isDbOnlyMode(),
      awsLiveAllowed: __AWS_LIVE_ENABLED,
      regionsEffective,
      regionsFromDb: runtime.regions,
      accountsFromDb: runtime.accounts,
      metrics: runtime.metrics
    });
  } catch (e) {
    console.error("meta/runtime", e);
    res.status(500).json({ error: "runtime_failed" });
  }
});

app.get("/api/meta/data-quality", async (req, res) => {
  try {
    const data = await getDataQuality();
    res.json({ ...data, dataFrom: __DATA_FROM_FLAG, dbOnly: isDbOnlyMode() });
  } catch (e) {
    console.error("meta/data-quality", e);
    res.status(500).json({ error: "data_quality_failed" });
  }
});

function dbDateToIso(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

app.get("/api/meta/freshness", async (req, res) => {
  try {
    const [costResult, s3Result, riCoverageResult, riUtilizationResult] = await Promise.all([
      query(`
        select metric, min(day)::date as min_day, max(day)::date as max_day, count(*)::int as rows
          from cost_daily
         group by metric
         order by metric
      `),
      query(`select max(day)::date as max_day, count(*)::int as rows from s3_bucket_daily`),
      query(`select max(day)::date as max_day, count(*)::int as rows from ri_coverage_daily`),
      query(`select max(day)::date as max_day, count(*)::int as rows from ri_utilization_daily`)
    ]);

    const byMetric = {};
    let latestCostDay = null;
    for (const row of costResult.rows || []) {
      const metric = row.metric || "unknown";
      const maxDay = dbDateToIso(row.max_day);
      byMetric[metric] = {
        minDay: dbDateToIso(row.min_day),
        maxDay,
        rows: Number(row.rows || 0)
      };
      if (maxDay && (!latestCostDay || maxDay > latestCostDay)) latestCostDay = maxDay;
    }

    res.json({
      dataFrom: __DATA_FROM_FLAG,
      dbOnly: isDbOnlyMode(),
      awsLiveAllowed: __AWS_LIVE_ENABLED,
      costs: {
        source: __DATA_FROM_FLAG === "LOCAL_DB" ? "db" : "aws",
        latestDay: latestCostDay,
        byMetric
      },
      s3: {
        source: "db",
        latestDay: dbDateToIso(s3Result.rows?.[0]?.max_day),
        rows: Number(s3Result.rows?.[0]?.rows || 0)
      },
      ri: {
        source: __DATA_FROM_FLAG === "LOCAL_DB" ? "db" : "aws",
        coverageLatestDay: dbDateToIso(riCoverageResult.rows?.[0]?.max_day),
        utilizationLatestDay: dbDateToIso(riUtilizationResult.rows?.[0]?.max_day)
      },
      savingsPlans: {
        source: isDbOnlyMode() ? "disabled-db-only" : "aws-cache",
        note: isDbOnlyMode()
          ? "Savings Plans live désactivé en mode DB-only."
          : "Savings Plans coverage/utilization are read from AWS Cost Explorer with persistent cache."
      }
    });
  } catch (e) {
    console.error("meta/freshness", e);
    res.status(500).json({ error: "freshness_failed" });
  }
});
