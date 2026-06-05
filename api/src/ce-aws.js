import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  GetDimensionValuesCommand,
  GetSavingsPlansCoverageCommand,
  GetSavingsPlansUtilizationCommand,
  GetReservationCoverageCommand,
  GetReservationUtilizationCommand
} from "@aws-sdk/client-cost-explorer";
import { SavingsplansClient, DescribeSavingsPlansCommand } from "@aws-sdk/client-savingsplans";

const region = process.env.AWS_REGION || "us-east-1";
export const ce = new CostExplorerClient({ region });
const spClient = new SavingsplansClient({ region });

const iso = (x) => {
  if (!x) return new Date().toISOString().slice(0, 10);
  const d = (x instanceof Date) ? x : new Date(x);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${x}`);
  return d.toISOString().slice(0, 10);
};

export async function listAccountsCE({ start, end } = {}){
  const TimePeriod = { Start: iso(start || new Date(Date.now() - 30 * 24 * 3600 * 1000)), End: iso(end || new Date()) };
  const out = await ce.send(new GetDimensionValuesCommand({
    TimePeriod,
    Dimension: "LINKED_ACCOUNT",
    Context: "COST_AND_USAGE"
  }));
  return (out.DimensionValues || []).map(v => ({
    accountId: v.Value,
    accountName: v.Attributes?.Description || v.Value
  })).filter(x => x.accountId);
}

export async function getCostsByService({ start, end, metric = "UnblendedCost", accounts }) {
  const rowsMap = new Map();
  let NextPageToken;
  const params = {
    TimePeriod: { Start: iso(start), End: iso(end) },
    Granularity: "DAILY",
    Metrics: [metric],
    GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
  };
  if (accounts && accounts.length) {
    params.Filter = { Dimensions: { Key: "LINKED_ACCOUNT", Values: accounts } };
  }
  do {
    const out = await ce.send(new GetCostAndUsageCommand({ ...params, NextPageToken }));
    for (const day of (out.ResultsByTime || [])) {
      for (const g of (day.Groups || [])) {
        const service = g.Keys?.[0] || "Unknown";
        const amount = Number(g.Metrics?.[metric]?.Amount || "0");
        rowsMap.set(service, (rowsMap.get(service) || 0) + amount);
      }
    }
    NextPageToken = out.NextPageToken;
  } while (NextPageToken);
  const rows = Array.from(rowsMap.entries()).map(([service, cost]) => ({ service, cost }));
  rows.sort((a, b) => b.cost - a.cost);
  return rows;
}

export async function getDailyTotalCosts({ start, end, metric = "UnblendedCost", accounts }) {
  const rows = [];
  let NextPageToken;
  const params = {
    TimePeriod: { Start: iso(start), End: iso(end) },
    Granularity: "DAILY",
    Metrics: [metric],
  };
  if (accounts && accounts.length) {
    params.Filter = { Dimensions: { Key: "LINKED_ACCOUNT", Values: accounts } };
  }
  do {
    const out = await ce.send(new GetCostAndUsageCommand({ ...params, NextPageToken }));
    for (const day of (out.ResultsByTime || [])) {
      const amount = Number(day.Total?.[metric]?.Amount || "0");
      rows.push({ date: day.TimePeriod?.Start, amountUSD: amount });
    }
    NextPageToken = out.NextPageToken;
  } while (NextPageToken);
  return rows;
}

export async function getTopCombos({ start, end, limit = 10, metric = "UnblendedCost", accounts }) {
  const map = new Map();
  let NextPageToken;
  const params = {
    TimePeriod: { Start: iso(start), End: iso(end) },
    Granularity: "DAILY",
    Metrics: [metric],
    GroupBy: [
      { Type: "DIMENSION", Key: "LINKED_ACCOUNT" },
      { Type: "DIMENSION", Key: "SERVICE" }
    ]
  };
  if (accounts && accounts.length) {
    params.Filter = { Dimensions: { Key: "LINKED_ACCOUNT", Values: accounts } };
  }
  do {
    const out = await ce.send(new GetCostAndUsageCommand({ ...params, NextPageToken }));
    for (const day of (out.ResultsByTime || [])) {
      for (const g of (day.Groups || [])) {
        const [linked_account, service] = g.Keys || [];
        const amount = Number(g.Metrics?.[metric]?.Amount || "0");
        const key = `${linked_account}|||${service}`;
        map.set(key, (map.get(key) || 0) + amount);
      }
    }
    NextPageToken = out.NextPageToken;
  } while (NextPageToken);
  const rows = Array.from(map.entries()).map(([key, cost]) => {
    const [linked_account, service] = key.split("|||");
    return { cost, service, linked_account };
  }).sort((a, b) => b.cost - a.cost).slice(0, Number(limit) || 10);
  return { rows };
}

// ---------- RI Coverage & Utilization ----------

export async function getRiCoverage({ start, end, groupBy = [] }) {
  const allowed = new Set(['INSTANCE_TYPE', 'REGION', 'TENANCY', 'PLATFORM', 'SCOPE']);
  const arr = Array.isArray(groupBy) ? groupBy : String(groupBy || "").split(",");
  const useGroupBy = arr.map(s => String(s).trim().toUpperCase()).filter(k => allowed.has(k));
  const paramsBase = {
    TimePeriod: { Start: iso(start), End: iso(end) },
  };
  if (useGroupBy.length) {
    paramsBase.GroupBy = useGroupBy.map(k => ({ Type: "DIMENSION", Key: k }));
  } else {
    paramsBase.Granularity = "DAILY";
  }
  const rows = [];
  let NextPageToken;
  do {
    const out = await ce.send(new GetReservationCoverageCommand({ ...paramsBase, NextPageToken }));
    for (const period of (out.CoveragesByTime || [])) {
      const date = period.TimePeriod?.Start;
      const groups = (period.Groups && period.Groups.length) ? period.Groups : [{ Attributes: {}, Coverage: period.Total }];
      for (const g of groups) {
        const ch = (g.Coverage || period.Total || {}).CoverageHours || {};
        rows.push({
          date,
          attributes: g.Attributes || {},
          coverageHours: Number(ch.CoverageHours || 0),
          coveragePct: Number(ch.CoverageHoursPercentage || 0),
          onDemandHours: Number(ch.OnDemandHours || 0),
          reservedHours: Number(ch.ReservedHours || 0),
          totalRunningHours: Number(ch.TotalRunningHours || 0)
        });
      }
    }
    NextPageToken = out.NextPageToken;
  } while (NextPageToken);
  return rows;
}

export async function getRiUtilization({ start, end, groupBy = [] }) {
  const arr = Array.isArray(groupBy) ? groupBy : String(groupBy || "").split(",");
  const useGroupBy = arr.map(s => String(s).trim().toUpperCase()).filter(k => k === "SUBSCRIPTION_ID");
  const params = {
    TimePeriod: { Start: iso(start), End: iso(end) }
  };
  if (useGroupBy.length) {
    params.GroupBy = useGroupBy.map(k => ({ Type: "DIMENSION", Key: k }));
  } else {
    params.Granularity = "DAILY";
  }
  const out = await ce.send(new GetReservationUtilizationCommand(params));
  const rows = [];
  for (const p of (out.UtilizationsByTime || [])) {
    if (p.Groups && p.Groups.length) {
      for (const g of p.Groups) {
        const t = g.Utilization || {};
        rows.push({
          date: p.TimePeriod?.Start,
          attributes: g.Attributes || {},
          purchasedHours: Number(t.PurchasedHours || 0),
          totalActualHours: Number(t.TotalActualHours || 0),
          unusedHours: Number(t.UnusedHours || 0),
          utilizationPct: Number(t.UtilizationPercentage || 0)
        });
      }
    } else {
      const t = p.Total || {};
      rows.push({
        date: p.TimePeriod?.Start,
        purchasedHours: Number(t.PurchasedHours || 0),
        totalActualHours: Number(t.TotalActualHours || 0),
        unusedHours: Number(t.UnusedHours || 0),
        utilizationPct: Number(t.UtilizationPercentage || 0)
      });
    }
  }
  return rows;
}

// ---------- Savings Plans Coverage & Utilization ----------

export async function listSavingsPlans({ states = [] } = {}) {
  const rows = [];
  const paramsBase = {};
  const allowedStates = new Set(["queued", "queued-deleted", "active", "payment-failed", "payment-pending", "retired", "returned", "pending-return"]);
  const normalizedStates = Array.isArray(states)
    ? states
        .filter(Boolean)
        .map(s => String(s).trim().toLowerCase().replace(/_/g, "-"))
        .filter(s => allowedStates.has(s))
    : [];
  if (normalizedStates.length) {
    paramsBase.states = normalizedStates;
  }

  let NextToken;
  do {
    try {
      const out = await spClient.send(new DescribeSavingsPlansCommand({ ...paramsBase, nextToken: NextToken }));
      for (const sp of (out.savingsPlans || out.SavingsPlans || [])) {
        rows.push({
          id: sp.savingsPlanId || sp.SavingsPlanId || "",
          arn: sp.savingsPlanArn || sp.SavingsPlanArn || "",
          description: sp.description || sp.Description || "",
          state: sp.state || sp.State || "",
          type: sp.savingsPlanType || sp.SavingsPlanType || "",
          paymentOption: sp.paymentOption || sp.PaymentOption || "",
          productTypes: Array.isArray(sp.productTypes || sp.ProductTypes) ? (sp.productTypes || sp.ProductTypes) : [],
          currency: sp.currency || sp.Currency || "USD",
          commitment: Number(sp.commitment ?? sp.Commitment ?? 0),
          upfrontPaymentAmount: Number(sp.upfrontPaymentAmount ?? sp.UpfrontPaymentAmount ?? 0),
          recurringPaymentAmount: Number(sp.recurringPaymentAmount ?? sp.RecurringPaymentAmount ?? 0),
          region: sp.region || sp.Region || "Any",
          instanceFamily: sp.ec2InstanceFamily || sp.EC2InstanceFamily || sp.instanceFamily || sp.InstanceFamily || "",
          start: sp.start || sp.Start || null,
          end: sp.end || sp.End || null,
          termDurationSeconds: Number(sp.termDurationInSeconds ?? sp.TermDurationInSeconds ?? 0),
          purchaseTime: sp.purchaseTime || sp.PurchaseTime || null,
          tags: sp.tags || sp.Tags || {},
        });
      }
      NextToken = out.nextToken || out.NextToken;
    } catch (err) {
      const code = String(err?.name || err?.Code || err?.code || "").toLowerCase();
      const msg = String(err?.message || "").toLowerCase();
      const hadStateFilter = paramsBase.states && paramsBase.states.length;
      const isValidation = code.includes("validation") || msg.includes("unsupported state");
      if (hadStateFilter && isValidation) {
        // Retry once without the states filter in case casing/allowed values differ per account/SDK.
        delete paramsBase.states;
        NextToken = undefined;
        continue;
      }
      throw err;
    }
  } while (NextToken);

  return rows;
}

export async function getSpCoverage({ start, end, groupBy = [] }) {
  // AWS CE now supports ARN/type/payment grouping. Keep a conservative allowlist and
  // fall back to a simpler query if CE rejects a requested dimension.
  const allowed = new Set([
    "SERVICE",
    "REGION",
    "INSTANCE_TYPE_FAMILY",
    "SAVINGS_PLAN_ARN",
    "SAVINGS_PLANS_TYPE",
    "PAYMENT_OPTION",
    "INSTANCE_TYPE"
  ]);
  const arr = Array.isArray(groupBy) ? groupBy : String(groupBy || "").split(",");
  const sanitized = arr.map(s => String(s).trim().toUpperCase()).filter(k => allowed.has(k));
  const MAX_GROUP_BY = 3;
  const primaryGroupBy = sanitized.slice(0, MAX_GROUP_BY);

  const fetchCoverage = async (groupKeys) => {
    const paramsBase = {
      TimePeriod: { Start: iso(start), End: iso(end) },
    };
    if (groupKeys.length) {
      paramsBase.GroupBy = groupKeys.map(k => ({ Type: "DIMENSION", Key: k }));
    } else {
      paramsBase.Granularity = "DAILY";
    }

    const rows = [];
    let NextToken;
    do {
      const out = await ce.send(new GetSavingsPlansCoverageCommand({ ...paramsBase, NextToken }));
      for (const sp of (out.SavingsPlansCoverages || [])) {
        const cov = sp.Coverage || {};
        rows.push({
          date: sp.TimePeriod?.Start,
          attributes: sp.Attributes || {},
          coveragePct: Number(cov.CoveragePercentage || 0),
          spendCoveredBySp: Number(cov.SpendCoveredBySavingsPlans || 0),
          onDemandCost: Number(cov.OnDemandCost || 0),
          totalCost: Number(cov.TotalCost || 0)
        });
      }
      NextToken = out.NextToken;
    } while (NextToken);
    return rows;
  };

  // Try the requested grouping first, then gracefully degrade to a safe subset.
  const fallbacks = [];
  if (primaryGroupBy.length) fallbacks.push(primaryGroupBy);
  const safeSubset = primaryGroupBy.filter(k => ["REGION", "INSTANCE_TYPE_FAMILY", "SERVICE"].includes(k));
  if (safeSubset.length && safeSubset.length < primaryGroupBy.length) {
    fallbacks.push(safeSubset);
  }
  fallbacks.push([]); // final fallback: daily totals (no GroupBy)

  let lastError = null;
  for (const groupKeys of fallbacks) {
    try {
      return await fetchCoverage(groupKeys);
    } catch (e) {
      const type = String(e?.name || e?.code || e?.__type || "");
      if (type.includes("Validation")) {
        lastError = e;
        continue;
      }
      throw e;
    }
  }

  if (lastError) {
    console.warn("getSpCoverage: CE rejected GroupBy; returning empty rows", lastError);
  }
  return [];
}

export async function getSpUtilization({ start, end, granularity = "DAILY" }) {
  const gran = String(granularity || "").toUpperCase() === "MONTHLY" ? "MONTHLY" : "DAILY";
  const params = { TimePeriod: { Start: iso(start), End: iso(end) }, Granularity: gran };
  let out;
  try {
    out = await ce.send(new GetSavingsPlansUtilizationCommand(params));
  } catch (e) {
    const type = String(e?.name || e?.code || e?.__type || "");
    if (type.includes("DataUnavailable")) {
      return { rows: [], summary: {
        totalCommitment: 0,
        usedCommitment: 0,
        unusedCommitment: 0,
        utilizationPct: 0,
        savings: {
          netSavings: 0,
          onDemandCostEquivalent: 0,
          totalSavings: 0,
        },
        amortizedCommitment: {
          total: 0,
          used: 0,
          unused: 0,
        }
      }};
    }
    throw e;
  }
  const rows = [];
  for (const p of (out.SavingsPlansUtilizationsByTime || [])) {
    const util = p.Utilization || {};
    const savings = p.Savings || {};
    const amortized = p.AmortizedCommitment || {};
    rows.push({
      date: p.TimePeriod?.Start,
      totalCommitment: Number(util.TotalCommitment || 0),
      usedCommitment: Number(util.UsedCommitment || 0),
      unusedCommitment: Number(util.UnusedCommitment || 0),
      utilizationPct: Number(util.UtilizationPercentage || 0),
      savings: {
        netSavings: Number(savings.NetSavings || 0),
        onDemandCostEquivalent: Number(savings.OnDemandCostEquivalent || 0),
        totalSavings: Number(savings.TotalSavings || 0),
      },
      amortizedCommitment: {
        total: Number(amortized.TotalCommitment || 0),
        used: Number(amortized.UsedCommitment || 0),
        unused: Number(amortized.UnusedCommitment || 0),
      }
    });
  }
  const totalUtil = out.Total?.Utilization || {};
  const totalSavings = out.Total?.Savings || {};
  const totalAmortized = out.Total?.AmortizedCommitment || {};
  const summary = {
    totalCommitment: Number(totalUtil.TotalCommitment || 0),
    usedCommitment: Number(totalUtil.UsedCommitment || 0),
    unusedCommitment: Number(totalUtil.UnusedCommitment || 0),
    utilizationPct: Number(totalUtil.UtilizationPercentage || 0),
    savings: {
      netSavings: Number(totalSavings.NetSavings || 0),
      onDemandCostEquivalent: Number(totalSavings.OnDemandCostEquivalent || 0),
      totalSavings: Number(totalSavings.TotalSavings || 0),
    },
    amortizedCommitment: {
      total: Number(totalAmortized.TotalCommitment || 0),
      used: Number(totalAmortized.UsedCommitment || 0),
      unused: Number(totalAmortized.UnusedCommitment || 0),
    }
  };
  return { rows, summary };
}

// Enhanced Top Combos: include region by looping per account (CE allows only 2 GroupBy)
// Returns: [{ cost, service, linked_account, region }]
export async function getTopCombosEx({ start, end, limit = 10, metric = "UnblendedCost", accounts }) {
  const accountIds = (accounts && accounts.length) ? accounts : (await listAccountsCE({ start, end })).map(a => a.accountId);
  const map = new Map(); // key: acc|service|region
  for (const acc of accountIds){
    let NextPageToken;
    const params = {
      TimePeriod: { Start: iso(start), End: iso(end) },
      Granularity: "DAILY",
      Metrics: [metric],
      GroupBy: [
        { Type: "DIMENSION", Key: "SERVICE" },
        { Type: "DIMENSION", Key: "REGION" }
      ],
      Filter: { Dimensions: { Key: "LINKED_ACCOUNT", Values: [acc] } }
    };
    do {
      const out = await ce.send(new GetCostAndUsageCommand({ ...params, NextPageToken }));
      for (const day of (out.ResultsByTime || [])) {
        for (const g of (day.Groups || [])) {
          const [service, region] = g.Keys || [];
          const amount = Number(g.Metrics?.[metric]?.Amount || "0");
          const key = `${acc}|||${service}|||${region||""}`;
          map.set(key, (map.get(key) || 0) + amount);
        }
      }
      NextPageToken = out.NextPageToken;
    } while (NextPageToken);
  }
  const rows = Array.from(map.entries()).map(([key, cost])=>{
    const [linked_account, service, region] = key.split("|||");
    return { cost, service, linked_account, region };
  });
  rows.sort((a,b)=> b.cost - a.cost);
  return rows.slice(0, limit);
}


// --- Added: getDailyCosts (for ingestion only; always uses AWS CE) ---
export async function getDailyCosts({ start, end, metric = "UnblendedCost", includeRegion = false, accounts = [], services = [] }) {
  const iso = (x) => {
    if (!x) return new Date().toISOString().slice(0, 10);
    const d = (x instanceof Date) ? x : new Date(x);
    if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${x}`);
    return d.toISOString().slice(0, 10);
  };
  const rows = [];
  const doFetch = async (params) => {
    let NextPageToken;
    do {
      const out = await ce.send(new GetCostAndUsageCommand({ ...params, NextPageToken }));
      for (const day of (out.ResultsByTime || [])) {
        for (const g of (day.Groups || [])) {
          // Keys order depends on grouping setup
          const keys = g.Keys || [];
          let accountId = "";
          let service = "";
          let region = "";
          if (includeRegion) {
            // params when includeRegion=true: GroupBy SERVICE + REGION, filtered by account
            // We run per-account loop in ce-aws.js callers when needed; here we assume Filter has a single account
            service = keys[0] || "Unknown";
            region  = keys[1] || "";
            // accountId is provided via Filter.Values[0]
            const accVals = (params.Filter && params.Filter.Dimensions && params.Filter.Dimensions.Values) || [];
            accountId = (accVals && accVals[0]) || "";
          } else {
            // GroupBy LINKED_ACCOUNT + SERVICE
            accountId = keys[0] || "";
            service   = keys[1] || "Unknown";
            region    = "";
          }
          // Filter services if requested
          if (services && services.length && !services.includes(service)) continue;
          const amount = Number(g.Metrics?.[metric]?.Amount || "0");
          // Usage quantity is not available unless metric=UsageQuantity; ensure numeric
          const usageQuantity = Number(g.Metrics?.UsageQuantity?.Amount || 0);
          rows.push({
            date: day.TimePeriod?.Start,
            accountId,
            service,
            region,
            metric,
            amountUSD: amount,
            usageQuantity: isFinite(usageQuantity) ? usageQuantity : 0
          });
        }
      }
      NextPageToken = out.NextPageToken;
    } while (NextPageToken);
  };

  if (includeRegion) {
    // Loop per account to stay within CE 2-GroupBy limit (SERVICE + REGION)
    const accs = Array.isArray(accounts) && accounts.length ? accounts : (await listAccountsCE({ start, end })).map(a => a.accountId);
    for (const acc of accs) {
      const params = {
        TimePeriod: { Start: iso(start), End: iso(end) },
        Granularity: "DAILY",
        Metrics: [metric, "UsageQuantity"],
        GroupBy: [
          { Type: "DIMENSION", Key: "SERVICE" },
          { Type: "DIMENSION", Key: "REGION" }
        ],
        Filter: { Dimensions: { Key: "LINKED_ACCOUNT", Values: [acc] } }
      };
      await doFetch(params);
    }
  } else {
    const params = {
      TimePeriod: { Start: iso(start), End: iso(end) },
      Granularity: "DAILY",
      Metrics: [metric, "UsageQuantity"],
      GroupBy: [
        { Type: "DIMENSION", Key: "LINKED_ACCOUNT" },
        { Type: "DIMENSION", Key: "SERVICE" }
      ]
    };
    if (accounts && accounts.length) {
      params.Filter = { Dimensions: { Key: "LINKED_ACCOUNT", Values: accounts } };
    }
    await doFetch(params);
  }
  return rows;
}
