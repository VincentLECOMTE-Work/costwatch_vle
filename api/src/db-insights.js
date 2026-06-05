import { query } from "./db.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function toIsoDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function diffDays(start, end) {
  const a = new Date(`${start}T00:00:00.000Z`);
  const b = new Date(`${end}T00:00:00.000Z`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 1;
  return Math.max(1, Math.round((b.getTime() - a.getTime()) / MS_PER_DAY));
}

function dateRange(start, end, maxDays = 370) {
  const days = [];
  let current = start;
  for (let i = 0; current && current < end && i < maxDays; i += 1) {
    days.push(current);
    current = addDays(current, 1);
  }
  return days;
}

function daysInMonth(isoDate) {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return 30;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
}

function monthStart(isoDate) {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return isoDate;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

function formatDateRange(start, end) {
  return `${start || "?"} -> ${end ? addDays(end, -1) : "?"}`;
}

function nextMonthStart(isoDate) {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return isoDate;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
}

function previousMonthStart(isoDate) {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return isoDate;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
}

function resolveComparisonWindow(start, end, spanDays) {
  const startsAtMonthStart = start && start === monthStart(start);
  const nextStart = startsAtMonthStart ? nextMonthStart(start) : null;
  const monthAligned = startsAtMonthStart && end === nextStart;

  if (monthAligned) {
    return {
      comparisonMode: "previous_calendar_month",
      previousStart: previousMonthStart(start),
      previousEnd: start
    };
  }

  const monthToDate = startsAtMonthStart && end > start && nextStart && end < nextStart;
  if (monthToDate) {
    const previousStart = previousMonthStart(start);
    const previousMonthEnd = start;
    const sameDayEnd = addDays(previousStart, spanDays);
    return {
      comparisonMode: "previous_month_to_date",
      previousStart,
      previousEnd: sameDayEnd && sameDayEnd < previousMonthEnd ? sameDayEnd : previousMonthEnd
    };
  }

  const previousEnd = start;
  return {
    comparisonMode: "previous_equal_days",
    previousStart: addDays(previousEnd, -spanDays),
    previousEnd
  };
}

function parseList(value) {
  if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean);
  return String(value || "").split(",").map(s => s.trim()).filter(Boolean);
}

function parseLimit(value, fallback = 20, max = 100) {
  const n = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, n);
}

async function latestDay(tableName) {
  const { rows } = await query(`select max(day)::date as max_day from ${tableName}`);
  return toIsoDate(rows?.[0]?.max_day);
}

async function resolveWindow({ start, end, table = "cost_daily", defaultDays = 30 } = {}) {
  const latest = await latestDay(table);
  const resolvedEnd = toIsoDate(end) || (latest ? addDays(latest, 1) : toIsoDate(new Date()));
  const resolvedStart = toIsoDate(start) || addDays(resolvedEnd, -defaultDays);
  const spanDays = diffDays(resolvedStart, resolvedEnd);
  const comparison = resolveComparisonWindow(resolvedStart, resolvedEnd, spanDays);
  return {
    start: resolvedStart,
    end: resolvedEnd,
    latestDay: latest,
    spanDays,
    ...comparison
  };
}

function addCostFilters(params, { start, end, metric = "UnblendedCost", accounts = [], regions = [], services = [], service = [], excludeTax = false } = {}, alias = "cost_daily") {
  const conds = [];
  const p = params;
  const prefix = alias ? `${alias}.` : "";
  if (start) {
    p.push(start);
    conds.push(`${prefix}day >= $${p.length}::date`);
  }
  if (end) {
    p.push(end);
    conds.push(`${prefix}day < $${p.length}::date`);
  }
  if (metric) {
    p.push(String(metric));
    conds.push(`${prefix}metric = $${p.length}`);
  }
  const accountList = parseList(accounts);
  if (accountList.length) {
    p.push(accountList);
    conds.push(`${prefix}account_id = any($${p.length})`);
  }
  const regionList = parseList(regions);
  if (regionList.length) {
    p.push(regionList);
    conds.push(`(nullif(${prefix}region, '') is null or ${prefix}region = any($${p.length}))`);
  }
  const serviceList = parseList(parseList(services).length ? services : service);
  if (serviceList.length) {
    p.push(serviceList);
    conds.push(`${prefix}service = any($${p.length})`);
  }
  if (excludeTax) {
    conds.push(`lower(${prefix}service) <> 'tax'`);
  }
  return conds;
}

function costWhereClause(filters) {
  return filters.length ? `where ${filters.join(" and ")}` : "";
}

function shiftSqlParams(sqlParts, offset) {
  return sqlParts.map(cond => cond.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + offset}`));
}

function pct(part, total) {
  const p = Number(part || 0);
  const t = Number(total || 0);
  return t > 0 ? (p / t) * 100 : 0;
}

function rowNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function safeActionId(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-z0-9_-]/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 180);
}

function normalizeStatus(value) {
  const status = String(value || "todo").toLowerCase();
  return ["todo", "ignored", "validated", "resolved"].includes(status) ? status : "todo";
}

function todayIso() {
  return toIsoDate(new Date());
}

export async function getDbRuntimeStatus() {
  const [regionsResult, accountsResult, metricsResult] = await Promise.all([
    query(`
      select region
        from cost_daily
       where nullif(region, '') is not null
       group by region
      union
      select region
        from s3_bucket_daily
       where nullif(region, '') is not null
       group by region
       order by region
    `),
    query(`
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
    `),
    query(`select metric, min(day)::date as min_day, max(day)::date as max_day, count(*)::int as rows from cost_daily group by metric order by metric`)
  ]);
  return {
    regions: (regionsResult.rows || []).map(r => r.region).filter(Boolean),
    accounts: (accountsResult.rows || []).map(r => r.account_id).filter(Boolean),
    metrics: (metricsResult.rows || []).map(r => ({
      metric: r.metric,
      minDay: toIsoDate(r.min_day),
      maxDay: toIsoDate(r.max_day),
      rows: rowNumber(r.rows)
    }))
  };
}

export async function getCostTrends(params = {}) {
  const metric = params.metric || "UnblendedCost";
  const window = await resolveWindow({ ...params, table: "cost_daily", defaultDays: 30 });
  const baseParams = [];
  const baseWhere = addCostFilters(baseParams, {
    ...params,
    start: window.start,
    end: window.end,
    metric
  });
  const previousParams = [];
  const previousWhere = addCostFilters(previousParams, {
    ...params,
    start: window.previousStart,
    end: window.previousEnd,
    metric
  });

  const [dailyResult, previousDailyResult, serviceResult, previousServiceResult] = await Promise.all([
    query(`
      select day::date as day, sum(amount_usd)::float as amount_usd
        from cost_daily
       ${baseWhere.length ? `where ${baseWhere.join(" and ")}` : ""}
       group by day
       order by day
    `, baseParams),
    query(`
      select day::date as day, sum(amount_usd)::float as amount_usd
        from cost_daily
       ${previousWhere.length ? `where ${previousWhere.join(" and ")}` : ""}
       group by day
       order by day
    `, previousParams),
    query(`
      select service, sum(amount_usd)::float as amount_usd
        from cost_daily
       ${baseWhere.length ? `where ${baseWhere.join(" and ")}` : ""}
       group by service
       order by amount_usd desc
       limit 12
    `, baseParams),
    query(`
      select service, sum(amount_usd)::float as amount_usd
        from cost_daily
       ${previousWhere.length ? `where ${previousWhere.join(" and ")}` : ""}
       group by service
    `, previousParams)
  ]);

  const daily = (dailyResult.rows || []).map((row, idx, arr) => {
    const cost = rowNumber(row.amount_usd);
    const startIdx = Math.max(0, idx - 6);
    const slice = arr.slice(startIdx, idx + 1);
    const avg7 = slice.reduce((sum, r) => sum + rowNumber(r.amount_usd), 0) / Math.max(1, slice.length);
    return {
      date: toIsoDate(row.day),
      cost,
      movingAverage7d: avg7
    };
  });
  const previousDaily = (previousDailyResult.rows || []).map(row => ({
    date: toIsoDate(row.day),
    cost: rowNumber(row.amount_usd)
  }));
  const total = daily.reduce((sum, row) => sum + row.cost, 0);
  const previousTotal = previousDaily.reduce((sum, row) => sum + row.cost, 0);
  const delta = total - previousTotal;
  const deltaPct = previousTotal > 0 ? (delta / previousTotal) * 100 : null;
  const latestCostDay = daily.length ? daily[daily.length - 1].date : window.latestDay;
  const observedDays = daily.filter(row => row.cost !== 0).length || daily.length || 0;
  const avgDaily = observedDays > 0 ? total / observedDays : 0;
  const projectionMonthEnd = latestCostDay ? avgDaily * daysInMonth(latestCostDay) : 0;

  const previousByService = new Map((previousServiceResult.rows || []).map(row => [row.service, rowNumber(row.amount_usd)]));
  const byService = (serviceResult.rows || []).map(row => {
    const cost = rowNumber(row.amount_usd);
    const previousCost = previousByService.get(row.service) || 0;
    return {
      service: row.service,
      cost,
      previousCost,
      delta: cost - previousCost,
      deltaPct: previousCost > 0 ? ((cost - previousCost) / previousCost) * 100 : null
    };
  });

  return {
    window,
    metric,
    summary: {
      total,
      previousTotal,
      delta,
      deltaPct,
      avgDaily,
      observedDays,
      latestCostDay,
      monthStart: latestCostDay ? monthStart(latestCostDay) : null,
      projectionMonthEnd
    },
    daily,
    previousDaily,
    byService
  };
}

export async function getCostAnomalies(params = {}) {
  const metric = params.metric || "UnblendedCost";
  const window = await resolveWindow({ ...params, table: "cost_daily", defaultDays: 14 });
  const limit = parseLimit(params.limit, 25, 100);
  const minAbs = Number(params.minAbs ?? params.min_abs ?? 1);
  const minPct = Number(params.minPct ?? params.min_pct ?? 20);
  const currentParams = [];
  const currentWhere = addCostFilters(currentParams, {
    ...params,
    start: window.start,
    end: window.end,
    metric
  }, "c");
  const previousParams = [];
  const previousWhere = addCostFilters(previousParams, {
    ...params,
    start: window.previousStart,
    end: window.previousEnd,
    metric
  }, "p");
  const qParams = [...currentParams, ...previousParams, minAbs, minPct, limit];
  const currentOffset = 0;
  const previousSql = previousWhere.map(cond => cond.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + currentParams.length}`)).join(" and ");

  const { rows } = await query(`
    with current_cost as (
      select account_id, service, coalesce(nullif(region, ''), '') as region, sum(amount_usd)::float as current_cost
        from cost_daily c
       ${currentWhere.length ? `where ${currentWhere.join(" and ")}` : ""}
       group by account_id, service, coalesce(nullif(region, ''), '')
    ),
    previous_cost as (
      select account_id, service, coalesce(nullif(region, ''), '') as region, sum(amount_usd)::float as previous_cost
        from cost_daily p
       ${previousSql ? `where ${previousSql}` : ""}
       group by account_id, service, coalesce(nullif(region, ''), '')
    ),
    joined as (
      select coalesce(c.account_id, p.account_id) as account_id,
             coalesce(c.service, p.service) as service,
             coalesce(c.region, p.region) as region,
             coalesce(c.current_cost, 0)::float as current_cost,
             coalesce(p.previous_cost, 0)::float as previous_cost
        from current_cost c
        full outer join previous_cost p
          on c.account_id = p.account_id
         and c.service = p.service
         and c.region = p.region
    )
    select account_id,
           service,
           region,
           current_cost,
           previous_cost,
           (current_cost - previous_cost)::float as delta,
           case when previous_cost > 0 then ((current_cost - previous_cost) / previous_cost) * 100.0 else null end as delta_pct
      from joined
     where abs(current_cost - previous_cost) >= $${currentParams.length + previousParams.length + 1}
       and (
         previous_cost = 0
         or abs(((current_cost - previous_cost) / nullif(previous_cost, 0)) * 100.0) >= $${currentParams.length + previousParams.length + 2}
       )
     order by abs(current_cost - previous_cost) desc
     limit $${currentParams.length + previousParams.length + 3}
  `, qParams);

  return {
    window: { ...window, currentOffset },
    metric,
    thresholds: { minAbs, minPct, limit },
    items: (rows || []).map(row => ({
      accountId: row.account_id,
      service: row.service,
      region: row.region || "",
      currentCost: rowNumber(row.current_cost),
      previousCost: rowNumber(row.previous_cost),
      delta: rowNumber(row.delta),
      deltaPct: row.delta_pct == null ? null : rowNumber(row.delta_pct)
    }))
  };
}

export async function getCostBreakdown(params = {}) {
  const metric = params.metric || "UnblendedCost";
  const window = await resolveWindow({ ...params, table: "cost_daily", defaultDays: 30 });
  const limit = parseLimit(params.limit, 12, 50);
  const p = [];
  const filters = addCostFilters(p, { ...params, start: window.start, end: window.end, metric });
  const where = costWhereClause(filters);

  const [accountsResult, servicesResult, accountServicesResult, dailyAccountsResult] = await Promise.all([
    query(`
      select account_id, sum(amount_usd)::float as cost
        from cost_daily
       ${where}
       group by account_id
       order by cost desc
       limit $${p.length + 1}
    `, [...p, limit]),
    query(`
      select service, sum(amount_usd)::float as cost
        from cost_daily
       ${where}
       group by service
       order by cost desc
       limit $${p.length + 1}
    `, [...p, limit]),
    query(`
      select account_id, service, sum(amount_usd)::float as cost
        from cost_daily
       ${where}
       group by account_id, service
       order by cost desc
       limit $${p.length + 1}
    `, [...p, Math.max(limit * 3, 20)]),
    query(`
      select day::date as day, account_id, sum(amount_usd)::float as cost
        from cost_daily
       ${where}
       group by day, account_id
       order by day asc, cost desc
    `, p)
  ]);

  const services = (servicesResult.rows || []).map(row => ({ service: row.service, cost: rowNumber(row.cost) }));
  const accounts = (accountsResult.rows || []).map(row => ({ accountId: row.account_id, cost: rowNumber(row.cost) }));
  const total = services.reduce((sum, row) => sum + row.cost, 0);
  return {
    window,
    metric,
    total,
    concentration: {
      topServiceSharePct: services.length ? pct(services[0].cost, total) : 0,
      topAccountSharePct: accounts.length ? pct(accounts[0].cost, total) : 0,
      top3ServicesSharePct: pct(services.slice(0, 3).reduce((sum, row) => sum + row.cost, 0), total),
      top3AccountsSharePct: pct(accounts.slice(0, 3).reduce((sum, row) => sum + row.cost, 0), total)
    },
    services: services.map(row => ({ ...row, sharePct: pct(row.cost, total) })),
    accounts: accounts.map(row => ({ ...row, sharePct: pct(row.cost, total) })),
    accountServices: (accountServicesResult.rows || []).map(row => ({
      accountId: row.account_id,
      service: row.service,
      cost: rowNumber(row.cost),
      sharePct: pct(row.cost, total)
    })),
    dailyAccounts: (dailyAccountsResult.rows || []).map(row => ({
      date: toIsoDate(row.day),
      accountId: row.account_id,
      cost: rowNumber(row.cost)
    }))
  };
}

export async function getCostHeatmap(params = {}) {
  const metric = params.metric || "UnblendedCost";
  const window = await resolveWindow({ ...params, table: "cost_daily", defaultDays: 30 });
  const limit = parseLimit(params.limit, 8, 20);
  const p = [];
  const filters = addCostFilters(p, { ...params, start: window.start, end: window.end, metric });
  const where = costWhereClause(filters);

  const topServicesResult = await query(`
    select service, sum(amount_usd)::float as cost
      from cost_daily
     ${where}
     group by service
     order by cost desc
     limit $${p.length + 1}
  `, [...p, limit]);
  const topServices = (topServicesResult.rows || []).map(row => row.service).filter(Boolean);
  if (!topServices.length) {
    return { window, metric, services: [], dailyServices: [], weekdays: [] };
  }

  const p2 = [...p, topServices];
  const serviceFilter = `service = any($${p2.length})`;
  const combinedWhere = costWhereClause([...filters, serviceFilter]);
  const [dailyResult, weekdayResult] = await Promise.all([
    query(`
      select day::date as day, service, sum(amount_usd)::float as cost
        from cost_daily
       ${combinedWhere}
       group by day, service
       order by day asc, service asc
    `, p2),
    query(`
      select extract(dow from day)::int as dow, service, avg(day_cost)::float as avg_cost
        from (
          select day, service, sum(amount_usd)::float as day_cost
            from cost_daily
           ${combinedWhere}
           group by day, service
        ) x
       group by dow, service
       order by dow, service
    `, p2)
  ]);

  return {
    window,
    metric,
    services: topServicesResult.rows.map(row => ({ service: row.service, cost: rowNumber(row.cost) })),
    dailyServices: (dailyResult.rows || []).map(row => ({
      date: toIsoDate(row.day),
      service: row.service,
      cost: rowNumber(row.cost)
    })),
    weekdays: (weekdayResult.rows || []).map(row => ({
      dow: rowNumber(row.dow),
      service: row.service,
      avgCost: rowNumber(row.avg_cost)
    }))
  };
}

function addS3Filters(params, { start, end, accounts = [], regions = [], buckets = [], bucket = [] } = {}, alias = "s3_bucket_daily") {
  const conds = [];
  const prefix = alias ? `${alias}.` : "";
  if (start) {
    params.push(start);
    conds.push(`${prefix}day >= $${params.length}::date`);
  }
  if (end) {
    params.push(end);
    conds.push(`${prefix}day < $${params.length}::date`);
  }
  const accountList = parseList(accounts);
  if (accountList.length) {
    params.push(accountList);
    conds.push(`${prefix}account_id = any($${params.length})`);
  }
  const regionList = parseList(regions);
  if (regionList.length) {
    params.push(regionList);
    conds.push(`${prefix}region = any($${params.length})`);
  }
  const bucketList = parseList(parseList(buckets).length ? buckets : bucket);
  if (bucketList.length) {
    params.push(bucketList);
    conds.push(`${prefix}bucket = any($${params.length})`);
  }
  return conds;
}

export async function getS3Growth(params = {}) {
  const window = await resolveWindow({ ...params, table: "s3_bucket_daily", defaultDays: 30 });
  const limit = parseLimit(params.limit, 25, 100);
  const p = [];
  const where = addS3Filters(p, { ...params, start: window.start, end: window.end }, "s");
  p.push(limit);
  const { rows } = await query(`
    with scoped as (
      select account_id, bucket, region, day, bytes_total, objects_total, bytes_by_class
        from s3_bucket_daily s
       ${where.length ? `where ${where.join(" and ")}` : ""}
    ),
    first_point as (
      select distinct on (account_id, bucket, region)
             account_id, bucket, region, day, bytes_total, objects_total
        from scoped
       order by account_id, bucket, region, day asc
    ),
    last_point as (
      select distinct on (account_id, bucket, region)
             account_id, bucket, region, day, bytes_total, objects_total, bytes_by_class
        from scoped
       order by account_id, bucket, region, day desc
    )
    select l.account_id,
           l.bucket,
           l.region,
           f.day::date as first_day,
           l.day::date as last_day,
           f.bytes_total::float as first_bytes,
           l.bytes_total::float as latest_bytes,
           (l.bytes_total - f.bytes_total)::float as growth_bytes,
           case when f.bytes_total > 0 then ((l.bytes_total - f.bytes_total) / f.bytes_total) * 100.0 else null end as growth_pct,
           f.objects_total::float as first_objects,
           l.objects_total::float as latest_objects,
           (l.objects_total - f.objects_total)::float as growth_objects,
           l.bytes_by_class
      from last_point l
      join first_point f
        on f.account_id = l.account_id
       and f.bucket = l.bucket
       and f.region = l.region
     order by abs(l.bytes_total - f.bytes_total) desc, l.bytes_total desc
     limit $${p.length}
  `, p);
  return {
    window,
    items: (rows || []).map(row => ({
      accountId: row.account_id,
      bucket: row.bucket,
      region: row.region,
      firstDay: toIsoDate(row.first_day),
      lastDay: toIsoDate(row.last_day),
      firstBytes: rowNumber(row.first_bytes),
      latestBytes: rowNumber(row.latest_bytes),
      growthBytes: rowNumber(row.growth_bytes),
      growthPct: row.growth_pct == null ? null : rowNumber(row.growth_pct),
      firstObjects: rowNumber(row.first_objects),
      latestObjects: rowNumber(row.latest_objects),
      growthObjects: rowNumber(row.growth_objects),
      classes: row.bytes_by_class || {}
    }))
  };
}

async function costPeriodTotal(params, start, end, metric) {
  const p = [];
  const filters = addCostFilters(p, { ...params, start, end, metric });
  const { rows } = await query(`
    select coalesce(sum(amount_usd), 0)::float as total,
           count(distinct day)::int as observed_days
      from cost_daily
     ${costWhereClause(filters)}
  `, p);
  return {
    total: rowNumber(rows?.[0]?.total),
    observedDays: rowNumber(rows?.[0]?.observed_days)
  };
}

async function costDailySeries(params, start, end, metric) {
  const p = [];
  const filters = addCostFilters(p, { ...params, start, end, metric });
  const { rows } = await query(`
    select day::date as day, sum(amount_usd)::float as cost
      from cost_daily
     ${costWhereClause(filters)}
     group by day
     order by day
  `, p);
  return (rows || []).map(row => ({
    date: toIsoDate(row.day),
    cost: rowNumber(row.cost)
  }));
}

function forecastRowFromPeriod(row, labelKey, daysRemaining) {
  const currentMtd = rowNumber(row.current_mtd);
  const currentDays = rowNumber(row.current_days);
  const recent7Cost = rowNumber(row.recent_7d);
  const recent7Days = rowNumber(row.recent_7d_days);
  const previousMonth = rowNumber(row.previous_month);
  const avgDailyMtd = currentDays > 0 ? currentMtd / currentDays : 0;
  const avgDaily7d = recent7Days > 0 ? recent7Cost / recent7Days : avgDailyMtd;
  const forecastMonthEnd = currentMtd + (avgDaily7d * Math.max(0, daysRemaining));
  const deltaVsPreviousMonth = forecastMonthEnd - previousMonth;
  return {
    [labelKey]: row.key,
    currentMtd,
    previousMonth,
    recent7Cost,
    avgDailyMtd,
    avgDaily7d,
    forecastMonthEnd,
    deltaVsPreviousMonth,
    deltaVsPreviousMonthPct: previousMonth > 0 ? (deltaVsPreviousMonth / previousMonth) * 100 : null,
    expectedOverrun: Math.max(0, deltaVsPreviousMonth)
  };
}

async function costForecastByDimension(params, { metric, mtdStart, currentEnd, recent7Start, previousStart, previousEnd, daysRemaining, labelKey, keyExpr, limit }) {
  const currentParams = [];
  const currentFilters = addCostFilters(currentParams, { ...params, start: mtdStart, end: currentEnd, metric });
  const recentParams = [];
  const recentFilters = addCostFilters(recentParams, { ...params, start: recent7Start, end: currentEnd, metric });
  const previousParams = [];
  const previousFilters = addCostFilters(previousParams, { ...params, start: previousStart, end: previousEnd, metric });

  const currentSql = costWhereClause(currentFilters);
  const recentSql = costWhereClause(shiftSqlParams(recentFilters, currentParams.length));
  const previousSql = costWhereClause(shiftSqlParams(previousFilters, currentParams.length + recentParams.length));
  const allParams = [...currentParams, ...recentParams, ...previousParams, limit];
  const limitParam = allParams.length;

  const { rows } = await query(`
    with current_period as (
      select ${keyExpr} as key,
             sum(amount_usd)::float as current_mtd,
             count(distinct day)::int as current_days
        from cost_daily
       ${currentSql}
       group by 1
    ),
    recent_period as (
      select ${keyExpr} as key,
             sum(amount_usd)::float as recent_7d,
             count(distinct day)::int as recent_7d_days
        from cost_daily
       ${recentSql}
       group by 1
    ),
    previous_period as (
      select ${keyExpr} as key,
             sum(amount_usd)::float as previous_month
        from cost_daily
       ${previousSql}
       group by 1
    )
    select coalesce(c.key, r.key, p.key) as key,
           coalesce(c.current_mtd, 0)::float as current_mtd,
           coalesce(c.current_days, 0)::int as current_days,
           coalesce(r.recent_7d, 0)::float as recent_7d,
           coalesce(r.recent_7d_days, 0)::int as recent_7d_days,
           coalesce(p.previous_month, 0)::float as previous_month
      from current_period c
      full outer join recent_period r on r.key = c.key
      full outer join previous_period p on p.key = coalesce(c.key, r.key)
     where coalesce(c.key, r.key, p.key) is not null
     order by (coalesce(c.current_mtd, 0) + coalesce(r.recent_7d, 0)) desc
     limit $${limitParam}
  `, allParams);

  return (rows || []).map(row => forecastRowFromPeriod(row, labelKey, daysRemaining));
}

export async function getCostForecast(params = {}) {
  const metric = params.metric || "UnblendedCost";
  const window = await resolveWindow({ ...params, table: "cost_daily", defaultDays: 35 });
  const latest = window.latestDay || await latestDay("cost_daily");
  const requestedAnchor = toIsoDate(params.anchor || addDays(window.end, -1));
  let anchor = requestedAnchor || latest || toIsoDate(new Date());
  if (latest && anchor > latest) anchor = latest;
  if (window.start && anchor < window.start && latest) anchor = latest;

  const mtdStart = monthStart(anchor);
  const monthEndExclusive = nextMonthStart(anchor);
  const currentEnd = addDays(anchor, 1);
  const previousStart = previousMonthStart(anchor);
  const previousEnd = mtdStart;
  const daysElapsed = diffDays(mtdStart, currentEnd);
  const totalMonthDays = diffDays(mtdStart, monthEndExclusive);
  const daysRemaining = Math.max(0, totalMonthDays - daysElapsed);
  const recent7Start = addDays(currentEnd, -7);
  const recent30Start = addDays(currentEnd, -30);
  const limit = parseLimit(params.limit, 10, 50);

  const [current, previous, recent7, recent30, daily, previousDaily, byAccount, byService] = await Promise.all([
    costPeriodTotal(params, mtdStart, currentEnd, metric),
    costPeriodTotal(params, previousStart, previousEnd, metric),
    costPeriodTotal(params, recent7Start, currentEnd, metric),
    costPeriodTotal(params, recent30Start, currentEnd, metric),
    costDailySeries(params, mtdStart, currentEnd, metric),
    costDailySeries(params, previousStart, previousEnd, metric),
    costForecastByDimension(params, {
      metric,
      mtdStart,
      currentEnd,
      recent7Start,
      previousStart,
      previousEnd,
      daysRemaining,
      labelKey: "accountId",
      keyExpr: "coalesce(nullif(account_id, ''), 'unknown')",
      limit
    }),
    costForecastByDimension(params, {
      metric,
      mtdStart,
      currentEnd,
      recent7Start,
      previousStart,
      previousEnd,
      daysRemaining,
      labelKey: "service",
      keyExpr: "coalesce(nullif(service, ''), 'unknown')",
      limit
    })
  ]);

  const avgDailyMtd = current.observedDays > 0 ? current.total / current.observedDays : 0;
  const avgDaily7d = recent7.observedDays > 0 ? recent7.total / recent7.observedDays : avgDailyMtd;
  const avgDaily30d = recent30.observedDays > 0 ? recent30.total / recent30.observedDays : avgDailyMtd;
  const forecastMtdRunRate = avgDailyMtd * totalMonthDays;
  const forecast7dTrend = current.total + (avgDaily7d * daysRemaining);
  const forecast30dTrend = current.total + (avgDaily30d * daysRemaining);
  const selectedForecast = forecast7dTrend || forecastMtdRunRate || forecast30dTrend;
  const deltaVsPreviousMonth = selectedForecast - previous.total;

  let cumulative = 0;
  const actualByDate = new Map(daily.map(row => [row.date, row.cost]));
  const projectedDaily = dateRange(mtdStart, monthEndExclusive, 45).map(date => {
    const actual = date <= anchor ? rowNumber(actualByDate.get(date)) : null;
    if (actual != null) {
      cumulative += actual;
      return { date, actual, projectedCumulative: cumulative, forecastDaily7d: null };
    }
    cumulative += avgDaily7d;
    return { date, actual: null, projectedCumulative: cumulative, forecastDaily7d: avgDaily7d };
  });

  return {
    window: {
      ...window,
      anchor,
      mtdStart,
      monthEndExclusive,
      previousStart,
      previousEnd,
      daysElapsed,
      daysRemaining,
      totalMonthDays
    },
    metric,
    summary: {
      currentMtd: current.total,
      previousMonth: previous.total,
      recent7Cost: recent7.total,
      recent30Cost: recent30.total,
      avgDailyMtd,
      avgDaily7d,
      avgDaily30d,
      forecastMtdRunRate,
      forecast7dTrend,
      forecast30dTrend,
      deltaVsPreviousMonth,
      deltaVsPreviousMonthPct: previous.total > 0 ? (deltaVsPreviousMonth / previous.total) * 100 : null,
      expectedOverrun: Math.max(0, deltaVsPreviousMonth)
    },
    daily,
    previousDaily,
    projectedDaily,
    byAccount,
    byService
  };
}

async function getCostDrilldown(params = {}) {
  const metric = params.metric || "UnblendedCost";
  const window = await resolveWindow({ ...params, table: "cost_daily", defaultDays: 30 });
  const scoped = {
    ...params,
    accounts: params.accountId || params.account_id ? [params.accountId || params.account_id] : params.accounts,
    services: params.service ? [params.service] : params.services,
    regions: params.region ? [params.region] : params.regions
  };
  const currentParams = [];
  const currentFilters = addCostFilters(currentParams, { ...scoped, start: window.start, end: window.end, metric });
  const currentWhere = costWhereClause(currentFilters);
  const previousParams = [];
  const previousFilters = addCostFilters(previousParams, { ...scoped, start: window.previousStart, end: window.previousEnd, metric });
  const previousWhere = costWhereClause(previousFilters);

  const [currentDaily, previousDaily, relatedAccountsResult, relatedServicesResult, relatedPairsResult] = await Promise.all([
    query(`
      select day::date as day, sum(amount_usd)::float as cost
        from cost_daily
       ${currentWhere}
       group by day
       order by day
    `, currentParams),
    query(`
      select day::date as day, sum(amount_usd)::float as cost
        from cost_daily
       ${previousWhere}
       group by day
       order by day
    `, previousParams),
    query(`
      select account_id, sum(amount_usd)::float as cost
        from cost_daily
       ${currentWhere}
       group by account_id
       order by cost desc
       limit 10
    `, currentParams),
    query(`
      select service, sum(amount_usd)::float as cost
        from cost_daily
       ${currentWhere}
       group by service
       order by cost desc
       limit 10
    `, currentParams),
    query(`
      select account_id, service, sum(amount_usd)::float as cost
        from cost_daily
       ${currentWhere}
       group by account_id, service
       order by cost desc
       limit 15
    `, currentParams)
  ]);

  const daily = (currentDaily.rows || []).map(row => ({ date: toIsoDate(row.day), cost: rowNumber(row.cost) }));
  const prevDaily = (previousDaily.rows || []).map(row => ({ date: toIsoDate(row.day), cost: rowNumber(row.cost) }));
  const currentTotal = daily.reduce((sum, row) => sum + row.cost, 0);
  const previousTotal = prevDaily.reduce((sum, row) => sum + row.cost, 0);
  const comparisonDaily = daily.map((row, idx) => ({
    date: row.date,
    cost: row.cost,
    previousDate: prevDaily[idx]?.date || null,
    previousCost: rowNumber(prevDaily[idx]?.cost)
  }));

  return {
    kind: params.kind || "cost",
    target: {
      accountId: params.accountId || params.account_id || null,
      service: params.service || null,
      region: params.region || null
    },
    window,
    metric,
    summary: {
      currentTotal,
      previousTotal,
      delta: currentTotal - previousTotal,
      deltaPct: previousTotal > 0 ? ((currentTotal - previousTotal) / previousTotal) * 100 : null,
      currentAvgDaily: daily.length ? currentTotal / daily.length : 0,
      previousAvgDaily: prevDaily.length ? previousTotal / prevDaily.length : 0
    },
    daily,
    previousDaily: prevDaily,
    comparisonDaily,
    related: {
      accounts: (relatedAccountsResult.rows || []).map(row => ({ accountId: row.account_id, cost: rowNumber(row.cost) })),
      services: (relatedServicesResult.rows || []).map(row => ({ service: row.service, cost: rowNumber(row.cost) })),
      accountServices: (relatedPairsResult.rows || []).map(row => ({
        accountId: row.account_id,
        service: row.service,
        cost: rowNumber(row.cost)
      }))
    }
  };
}

async function getS3Drilldown(params = {}) {
  const window = await resolveWindow({ ...params, table: "s3_bucket_daily", defaultDays: 30 });
  const scoped = {
    ...params,
    accounts: params.accountId || params.account_id ? [params.accountId || params.account_id] : params.accounts,
    buckets: params.bucket ? [params.bucket] : params.buckets,
    regions: params.region ? [params.region] : params.regions
  };
  const currentParams = [];
  const currentFilters = addS3Filters(currentParams, { ...scoped, start: window.start, end: window.end }, "s");
  const currentWhere = costWhereClause(currentFilters);
  const previousParams = [];
  const previousFilters = addS3Filters(previousParams, { ...scoped, start: window.previousStart, end: window.previousEnd }, "s");
  const previousWhere = costWhereClause(previousFilters);
  const [currentDailyResult, previousDailyResult, bucketsResult, accountsResult, latestResult] = await Promise.all([
    query(`
      select day::date as day, sum(bytes_total)::float as bytes_total, sum(objects_total)::float as objects_total
        from s3_bucket_daily s
       ${currentWhere}
       group by day
       order by day
    `, currentParams),
    query(`
      select day::date as day, sum(bytes_total)::float as bytes_total, sum(objects_total)::float as objects_total
        from s3_bucket_daily s
       ${previousWhere}
       group by day
       order by day
    `, previousParams),
    query(`
      select bucket, region, sum(bytes_total)::float as bytes_total, max(day)::date as latest_day
        from s3_bucket_daily s
       ${currentWhere}
       group by bucket, region
       order by bytes_total desc
       limit 10
    `, currentParams),
    query(`
      select account_id, sum(bytes_total)::float as bytes_total
        from s3_bucket_daily s
       ${currentWhere}
       group by account_id
       order by bytes_total desc
       limit 10
    `, currentParams),
    query(`
      select distinct on (account_id, bucket, region)
             account_id, bucket, region, day::date as day, bytes_total::float as bytes_total,
             objects_total::float as objects_total, bytes_by_class
        from s3_bucket_daily s
       ${currentWhere}
       order by account_id, bucket, region, day desc
    `, currentParams)
  ]);

  const daily = (currentDailyResult.rows || []).map(row => ({
    date: toIsoDate(row.day),
    bytesTotal: rowNumber(row.bytes_total),
    objectsTotal: rowNumber(row.objects_total)
  }));
  const previousDaily = (previousDailyResult.rows || []).map(row => ({
    date: toIsoDate(row.day),
    bytesTotal: rowNumber(row.bytes_total),
    objectsTotal: rowNumber(row.objects_total)
  }));
  const first = daily[0] || {};
  const last = daily[daily.length - 1] || {};
  const prevFirst = previousDaily[0] || {};
  const prevLast = previousDaily[previousDaily.length - 1] || {};
  const classes = {};
  for (const row of latestResult.rows || []) {
    for (const [key, value] of Object.entries(row.bytes_by_class || {})) {
      classes[key] = rowNumber(classes[key]) + rowNumber(value);
    }
  }

  return {
    kind: "bucket",
    target: {
      accountId: params.accountId || params.account_id || null,
      bucket: params.bucket || null,
      region: params.region || null
    },
    window,
    summary: {
      currentLatestBytes: rowNumber(last.bytesTotal),
      currentFirstBytes: rowNumber(first.bytesTotal),
      currentGrowthBytes: rowNumber(last.bytesTotal) - rowNumber(first.bytesTotal),
      previousLatestBytes: rowNumber(prevLast.bytesTotal),
      previousGrowthBytes: rowNumber(prevLast.bytesTotal) - rowNumber(prevFirst.bytesTotal),
      latestObjects: rowNumber(last.objectsTotal),
      classes
    },
    daily,
    previousDaily,
    related: {
      buckets: (bucketsResult.rows || []).map(row => ({
        bucket: row.bucket,
        region: row.region,
        latestDay: toIsoDate(row.latest_day),
        bytesTotal: rowNumber(row.bytes_total)
      })),
      accounts: (accountsResult.rows || []).map(row => ({
        accountId: row.account_id,
        bytesTotal: rowNumber(row.bytes_total)
      }))
    }
  };
}

export async function getInsightDrilldown(params = {}) {
  const kind = String(params.kind || "cost").toLowerCase();
  if (kind === "bucket" || kind === "s3") return getS3Drilldown({ ...params, kind: "bucket" });
  return getCostDrilldown(params);
}

export async function getCoverageSummary(params = {}) {
  const window = await resolveWindow({ ...params, table: "ri_coverage_daily", defaultDays: 30 });
  const p = [window.start, window.end];
  const { rows } = await query(`
    with cov as (
      select day,
             sum(coverage_hours)::float as coverage_hours,
             sum(on_demand_hours)::float as on_demand_hours,
             sum(reserved_hours)::float as reserved_hours,
             sum(total_running_hours)::float as total_running_hours
        from ri_coverage_daily
       where day >= $1::date and day < $2::date
       group by day
    ),
    util as (
      select day,
             sum(purchased_hours)::float as purchased_hours,
             sum(total_actual_hours)::float as total_actual_hours,
             sum(unused_hours)::float as unused_hours
        from ri_utilization_daily
       where day >= $1::date and day < $2::date
       group by day
    )
    select coalesce(cov.day, util.day)::date as day,
           cov.coverage_hours,
           cov.on_demand_hours,
           cov.reserved_hours,
           cov.total_running_hours,
           case when cov.total_running_hours > 0 then (cov.reserved_hours / cov.total_running_hours) * 100.0 else 0 end as coverage_pct,
           util.purchased_hours,
           util.total_actual_hours,
           util.unused_hours,
           case when util.total_actual_hours > 0 then ((util.total_actual_hours - util.unused_hours) / util.total_actual_hours) * 100.0 else 0 end as utilization_pct
      from cov
      full outer join util on util.day = cov.day
     order by day
  `, p);

  const daily = (rows || []).map(row => ({
    date: toIsoDate(row.day),
    coverageHours: rowNumber(row.coverage_hours),
    onDemandHours: rowNumber(row.on_demand_hours),
    reservedHours: rowNumber(row.reserved_hours),
    totalRunningHours: rowNumber(row.total_running_hours),
    coveragePct: rowNumber(row.coverage_pct),
    purchasedHours: rowNumber(row.purchased_hours),
    totalActualHours: rowNumber(row.total_actual_hours),
    unusedHours: rowNumber(row.unused_hours),
    utilizationPct: rowNumber(row.utilization_pct)
  }));
  const avg = (key) => daily.length ? daily.reduce((sum, row) => sum + rowNumber(row[key]), 0) / daily.length : 0;
  const total = (key) => daily.reduce((sum, row) => sum + rowNumber(row[key]), 0);
  const latest = daily.length ? daily[daily.length - 1] : null;
  return {
    window,
    summary: {
      avgCoveragePct: avg("coveragePct"),
      avgUtilizationPct: avg("utilizationPct"),
      onDemandHours: total("onDemandHours"),
      reservedHours: total("reservedHours"),
      unusedHours: total("unusedHours"),
      purchasedHours: total("purchasedHours"),
      latest
    },
    daily
  };
}

async function tableStats(tableName) {
  const { rows } = await query(`select min(day)::date as min_day, max(day)::date as max_day, count(*)::int as rows from ${tableName}`);
  const row = rows?.[0] || {};
  return {
    table: tableName,
    minDay: toIsoDate(row.min_day),
    maxDay: toIsoDate(row.max_day),
    rows: rowNumber(row.rows)
  };
}

export async function getDataQuality() {
  const [costStats, s3Stats, riCoverageStats, riUtilizationStats, metricsResult, costGapsResult, s3GapsResult, runtime] = await Promise.all([
    tableStats("cost_daily"),
    tableStats("s3_bucket_daily"),
    tableStats("ri_coverage_daily"),
    tableStats("ri_utilization_daily"),
    query(`
      select metric,
             min(day)::date as min_day,
             max(day)::date as max_day,
             count(*)::int as rows,
             count(distinct account_id)::int as accounts,
             count(distinct service)::int as services,
             count(distinct region)::int as regions
        from cost_daily
       group by metric
       order by metric
    `),
    query(`
      with bounds as (
        select metric, min(day)::date as min_day, max(day)::date as max_day
          from cost_daily
         group by metric
      ),
      expected as (
        select b.metric, gs::date as day
          from bounds b
         cross join lateral generate_series(b.min_day, b.max_day, interval '1 day') gs
      ),
      present as (
        select metric, day
          from cost_daily
         group by metric, day
      )
      select e.metric, count(*)::int as missing_days
        from expected e
        left join present p on p.metric = e.metric and p.day = e.day
       where p.day is null
       group by e.metric
       order by e.metric
    `),
    query(`
      with bounds as (
        select min(day)::date as min_day, max(day)::date as max_day from s3_bucket_daily
      ),
      expected as (
        select gs::date as day
          from bounds b
         cross join lateral generate_series(b.min_day, b.max_day, interval '1 day') gs
         where b.min_day is not null and b.max_day is not null
      ),
      present as (
        select day from s3_bucket_daily group by day
      )
      select count(*)::int as missing_days
        from expected e
        left join present p on p.day = e.day
       where p.day is null
    `),
    getDbRuntimeStatus()
  ]);

  const costGapByMetric = {};
  for (const row of costGapsResult.rows || []) costGapByMetric[row.metric] = rowNumber(row.missing_days);

  return {
    generatedAt: new Date().toISOString(),
    tables: [costStats, s3Stats, riCoverageStats, riUtilizationStats],
    costs: {
      metrics: (metricsResult.rows || []).map(row => ({
        metric: row.metric,
        minDay: toIsoDate(row.min_day),
        maxDay: toIsoDate(row.max_day),
        rows: rowNumber(row.rows),
        accounts: rowNumber(row.accounts),
        services: rowNumber(row.services),
        regions: rowNumber(row.regions),
        missingDays: costGapByMetric[row.metric] || 0
      }))
    },
    s3: {
      missingDays: rowNumber(s3GapsResult.rows?.[0]?.missing_days)
    },
    dimensions: {
      regions: runtime.regions,
      accounts: runtime.accounts
    }
  };
}

async function ensureFinOpsActionStateSchema() {
  await query(`
    create table if not exists finops_action_state (
      action_id text primary key,
      status text not null default 'todo',
      snoozed_until date,
      note text not null default '',
      updated_at timestamptz not null default now()
    );
    create index if not exists idx_finops_action_state_status on finops_action_state(status);
    create index if not exists idx_finops_action_state_snoozed_until on finops_action_state(snoozed_until);
  `);
}

async function finOpsActionStateMap(actionIds = []) {
  await ensureFinOpsActionStateSchema();
  const ids = parseList(actionIds);
  const result = ids.length
    ? await query(`
        select action_id, status, snoozed_until::date as snoozed_until, note, updated_at
          from finops_action_state
         where action_id = any($1)
      `, [ids])
    : await query(`
        select action_id, status, snoozed_until::date as snoozed_until, note, updated_at
          from finops_action_state
         order by updated_at desc
      `);
  const map = new Map();
  for (const row of result.rows || []) {
    map.set(row.action_id, {
      actionId: row.action_id,
      status: normalizeStatus(row.status),
      snoozedUntil: toIsoDate(row.snoozed_until),
      note: row.note || "",
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
    });
  }
  return map;
}

export async function getFinOpsActionStates(actionIds = []) {
  const map = await finOpsActionStateMap(actionIds);
  return { items: Array.from(map.values()) };
}

export async function setFinOpsActionState(actionId, patch = {}) {
  await ensureFinOpsActionStateSchema();
  const id = safeActionId(actionId);
  if (!id) {
    const error = new Error("invalid_action_id");
    error.status = 400;
    throw error;
  }

  const existingResult = await query(`
    select action_id, status, snoozed_until::date as snoozed_until, note
      from finops_action_state
     where action_id = $1
  `, [id]);
  const existing = existingResult.rows?.[0] || {};
  const status = patch.status == null ? normalizeStatus(existing.status) : normalizeStatus(patch.status);
  let snoozedUntil = toIsoDate(existing.snoozed_until);
  const snoozeDays = Number.parseInt(String(patch.snoozeDays ?? patch.snooze_days ?? ""), 10);
  if (patch.clearSnooze || patch.clear_snooze) {
    snoozedUntil = null;
  } else if (Number.isFinite(snoozeDays) && snoozeDays > 0) {
    snoozedUntil = addDays(todayIso(), Math.min(365, snoozeDays));
  } else if (Object.prototype.hasOwnProperty.call(patch, "snoozedUntil") || Object.prototype.hasOwnProperty.call(patch, "snoozed_until")) {
    snoozedUntil = toIsoDate(patch.snoozedUntil ?? patch.snoozed_until);
  }
  const note = patch.note == null ? String(existing.note || "") : String(patch.note || "").slice(0, 2000);

  const { rows } = await query(`
    insert into finops_action_state (action_id, status, snoozed_until, note, updated_at)
    values ($1, $2, $3::date, $4, now())
    on conflict (action_id) do update set
      status = excluded.status,
      snoozed_until = excluded.snoozed_until,
      note = excluded.note,
      updated_at = now()
    returning action_id, status, snoozed_until::date as snoozed_until, note, updated_at
  `, [id, status, snoozedUntil, note]);
  const row = rows?.[0] || {};
  return {
    actionId: row.action_id,
    status: normalizeStatus(row.status),
    snoozedUntil: toIsoDate(row.snoozed_until),
    note: row.note || "",
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    isSnoozed: Boolean(toIsoDate(row.snoozed_until) && toIsoDate(row.snoozed_until) >= todayIso())
  };
}

async function attachActionStates(actions) {
  const stateMap = await finOpsActionStateMap(actions.map(action => action.id));
  const today = todayIso();
  return actions.map(action => {
    const state = stateMap.get(action.id) || {};
    const snoozedUntil = toIsoDate(state.snoozedUntil);
    return {
      ...action,
      status: normalizeStatus(state.status),
      snoozedUntil,
      isSnoozed: Boolean(snoozedUntil && snoozedUntil >= today),
      note: state.note || "",
      stateUpdatedAt: state.updatedAt || null
    };
  });
}

export async function getFinOpsActions(params = {}) {
  const actionLimit = parseLimit(params.limit, 12, 50);
  const [trends, anomalies, s3Growth, coverage, quality, breakdown] = await Promise.all([
    getCostTrends(params),
    getCostAnomalies({ ...params, limit: 12, minAbs: params.minAbs ?? 1, minPct: params.minPct ?? 15 }),
    getS3Growth({ ...params, limit: 12 }),
    getCoverageSummary(params),
    getDataQuality(),
    getCostBreakdown({ ...params, limit: 10 })
  ]);

  const actions = [];
  const push = (action) => {
    actions.push({
      id: safeActionId(action.id || `action-${actions.length + 1}`),
      priority: action.priority || "medium",
      category: action.category || "cost",
      title: action.title,
      detail: action.detail || "",
      impactUSD: rowNumber(action.impactUSD),
      impactLabel: action.impactLabel || "",
      source: action.source || "db",
      evidence: action.evidence || {}
    });
  };

  const positiveAnomalies = (anomalies.items || [])
    .filter(item => rowNumber(item.delta) > 0)
    .sort((a, b) => rowNumber(b.delta) - rowNumber(a.delta));
  const anomalyPreviousRange = formatDateRange(anomalies.window?.previousStart, anomalies.window?.previousEnd);
  for (const item of positiveAnomalies.slice(0, 4)) {
    push({
      id: `anomaly-${item.accountId}-${item.service}`,
      priority: rowNumber(item.delta) >= 500 ? "high" : "medium",
      category: "anomaly",
      title: `Hausse ${item.service}`,
      detail: `${item.accountId}${item.region ? ` / ${item.region}` : ""}: ${item.deltaPct == null ? "nouvelle dépense" : `${item.deltaPct.toFixed(1)}%`} vs ${anomalyPreviousRange}.`,
      impactUSD: item.delta,
      source: "cost_daily",
      evidence: item
    });
  }

  const monthDelta = rowNumber(trends.summary?.delta);
  if (Math.abs(monthDelta) >= 100) {
    push({
      id: "period-delta",
      priority: monthDelta > 0 ? "high" : "low",
      category: "run_rate",
      title: monthDelta > 0 ? "Run-rate en hausse" : "Run-rate en baisse",
      detail: `${formatDateRange(trends.window.start, trends.window.end)}: ${monthDelta > 0 ? "+" : "-"}${Math.abs(trends.summary.deltaPct || 0).toFixed(1)}% vs ${formatDateRange(trends.window.previousStart, trends.window.previousEnd)}.`,
      impactUSD: monthDelta,
      source: "cost_daily",
      evidence: trends.summary
    });
  }

  const growingBuckets = (s3Growth.items || [])
    .filter(item => rowNumber(item.growthBytes) > 0)
    .sort((a, b) => rowNumber(b.growthBytes) - rowNumber(a.growthBytes));
  for (const item of growingBuckets.slice(0, 3)) {
    push({
      id: `s3-growth-${item.accountId}-${item.bucket}`,
      priority: rowNumber(item.growthBytes) > 1_000_000_000_000 ? "medium" : "low",
      category: "s3",
      title: `Croissance S3: ${item.bucket}`,
      detail: `${item.region}: +${(rowNumber(item.growthBytes) / 1e12).toFixed(2)} TB sur la période.`,
      impactUSD: 0,
      impactLabel: `${item.growthPct == null ? "n/a" : `+${item.growthPct.toFixed(1)}%`}`,
      source: "s3_bucket_daily",
      evidence: item
    });
  }

  const unusedHours = rowNumber(coverage.summary?.unusedHours);
  const utilizationPct = rowNumber(coverage.summary?.avgUtilizationPct);
  if (unusedHours > 0 || (utilizationPct > 0 && utilizationPct < 85)) {
    push({
      id: "ri-unused-hours",
      priority: utilizationPct > 0 && utilizationPct < 75 ? "high" : "medium",
      category: "ri",
      title: "Réservations sous-utilisées",
      detail: `${unusedHours.toFixed(0)} heure(s) inutilisées, utilisation moyenne ${utilizationPct.toFixed(1)}%.`,
      impactUSD: 0,
      impactLabel: `${unusedHours.toFixed(0)} h`,
      source: "ri_utilization_daily",
      evidence: coverage.summary
    });
  }

  const topServiceShare = rowNumber(breakdown.concentration?.topServiceSharePct);
  const topAccountShare = rowNumber(breakdown.concentration?.topAccountSharePct);
  if (topServiceShare >= 40 && breakdown.services?.[0]) {
    push({
      id: "service-concentration",
      priority: "medium",
      category: "concentration",
      title: `Concentration service: ${breakdown.services[0].service}`,
      detail: `${topServiceShare.toFixed(1)}% du coût période est porté par un seul service.`,
      impactUSD: rowNumber(breakdown.services[0].cost),
      source: "cost_daily",
      evidence: breakdown.services[0]
    });
  }
  if (topAccountShare >= 45 && breakdown.accounts?.[0]) {
    push({
      id: "account-concentration",
      priority: "medium",
      category: "concentration",
      title: `Concentration compte: ${breakdown.accounts[0].accountId}`,
      detail: `${topAccountShare.toFixed(1)}% du coût période est porté par un seul compte.`,
      impactUSD: rowNumber(breakdown.accounts[0].cost),
      source: "cost_daily",
      evidence: breakdown.accounts[0]
    });
  }

  const gapMetrics = (quality.costs?.metrics || []).filter(metric => rowNumber(metric.missingDays) > 0);
  if (gapMetrics.length) {
    push({
      id: "data-gaps",
      priority: "medium",
      category: "quality",
      title: "Trous de données coût",
      detail: gapMetrics.map(metric => `${metric.metric}: ${metric.missingDays} j`).join(" · "),
      impactUSD: 0,
      impactLabel: `${gapMetrics.reduce((sum, metric) => sum + rowNumber(metric.missingDays), 0)} jours`,
      source: "cost_daily",
      evidence: gapMetrics
    });
  }

  const priorityOrder = { high: 0, medium: 1, low: 2 };
  actions.sort((a, b) => {
    const p = (priorityOrder[a.priority] ?? 9) - (priorityOrder[b.priority] ?? 9);
    if (p !== 0) return p;
    return Math.abs(rowNumber(b.impactUSD)) - Math.abs(rowNumber(a.impactUSD));
  });

  const enrichedActions = await attachActionStates(actions);
  const statusOrder = { todo: 0, validated: 1, ignored: 2, resolved: 3 };
  enrichedActions.sort((a, b) => {
    if (a.isSnoozed !== b.isSnoozed) return a.isSnoozed ? 1 : -1;
    const s = (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9);
    if (s !== 0) return s;
    const p = (priorityOrder[a.priority] ?? 9) - (priorityOrder[b.priority] ?? 9);
    if (p !== 0) return p;
    return Math.abs(rowNumber(b.impactUSD)) - Math.abs(rowNumber(a.impactUSD));
  });

  return {
    window: trends.window,
    generatedAt: new Date().toISOString(),
    items: enrichedActions.slice(0, actionLimit)
  };
}
