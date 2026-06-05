
import { query } from "./db.js";

function toISO(x){
  if (!x) return new Date().toISOString().slice(0,10);
  const d = (x instanceof Date) ? x : new Date(x);
  if (Number.isNaN(d.getTime())) throw new Error("Invalid date: "+x);
  return d.toISOString().slice(0,10);
}

function dbDateToISO(x){
  if (!x) return "";
  if (x instanceof Date && !Number.isNaN(x.getTime())) {
    const y = x.getFullYear();
    const m = String(x.getMonth() + 1).padStart(2, "0");
    const d = String(x.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(x).slice(0, 10);
}

function whereRange(start, end, idxStart=1){
  const hasStart = !!start, hasEnd = !!end;
  const conds = [];
  const params = [];
  if (hasStart){ conds.push(`day >= $${idxStart}`); params.push(toISO(start)); }
  if (hasEnd){ conds.push(`day < $${idxStart + params.length}`); params.push(toISO(end)); }
  const sql = conds.length ? ("where " + conds.join(" and ")) : "";
  return { sql, params };
}

export async function listAccountsCE({ start, end } = {}){
  const { sql, params } = whereRange(start, end);
  const q = `select distinct account_id from cost_daily ${sql} order by account_id`;
  const { rows } = await query(q, params);
  return rows.map(r => ({ accountId: r.account_id, accountName: r.account_id }));
}

export async function getCostsByService({ start, end, metric = "UnblendedCost", accounts = [] }){
  const { sql, params } = whereRange(start, end);
  const extra = [];
  const p = params.slice();
  if (accounts && accounts.length){
    extra.push(`account_id = any($${p.length+1})`); p.push(accounts);
  }
  extra.push(`metric = $${p.length+1}`); p.push(String(metric));
  const where = [sql.replace(/^where\s*/,'').trim(), ...extra].filter(Boolean).join(" and ");
  const q = `select service, sum(amount_usd)::float as amount_usd
             from cost_daily
             ${where ? "where "+where : ""}
             group by service
             order by amount_usd desc`;
  const { rows } = await query(q, p);
  return rows.map(r => ({ service: r.service, amountUSD: Number(r.amount_usd||0) }));
}

export async function getDailyTotalCosts({ start, end, metric = "UnblendedCost", accounts = [] }){
  const { sql, params } = whereRange(start, end);
  const extra = [];
  const p = params.slice();
  if (accounts && accounts.length){
    extra.push(`account_id = any($${p.length+1})`); p.push(accounts);
  }
  extra.push(`metric = $${p.length+1}`); p.push(String(metric));
  const where = [sql.replace(/^where\s*/,'').trim(), ...extra].filter(Boolean).join(" and ");
  const q = `select day::date as date, sum(amount_usd)::float as amount_usd
             from cost_daily
             ${where ? "where "+where : ""}
             group by day
             order by day asc`;
  const { rows } = await query(q, p);
  return rows.map(r => ({ date: dbDateToISO(r.date), amountUSD: Number(r.amount_usd||0) }));
}

export async function getTopCombos({ start, end, limit = 10, metric = "UnblendedCost", accounts = [] }){
  const { sql, params } = whereRange(start, end);
  const extra = [];
  const p = params.slice();
  if (accounts && accounts.length){
    extra.push(`account_id = any($${p.length+1})`); p.push(accounts);
  }
  extra.push(`metric = $${p.length+1}`); p.push(String(metric));
  const where = [sql.replace(/^where\s*/,'').trim(), ...extra].filter(Boolean).join(" and ");
  const q = `select account_id as linked_account, service, sum(amount_usd)::float as cost
             from cost_daily
             ${where ? "where "+where : ""}
             group by account_id, service
             order by cost desc
             limit $${p.length+1}`;
  p.push(limit);
  const { rows } = await query(q, p);
  return rows.map(r => ({ linked_account: r.linked_account, service: r.service, cost: Number(r.cost||0) }));
}

export async function getTopCombosEx({ start, end, limit = 10, metric = "UnblendedCost", accounts = [] }){
  const { sql, params } = whereRange(start, end);
  const extra = [];
  const p = params.slice();
  if (accounts && accounts.length){
    extra.push(`account_id = any($${p.length+1})`); p.push(accounts);
  }
  extra.push(`metric = $${p.length+1}`); p.push(String(metric));
  const where = [sql.replace(/^where\s*/,'').trim(), ...extra].filter(Boolean).join(" and ");
  const q = `select account_id as linked_account, service, coalesce(nullif(region,''),'') as region, sum(amount_usd)::float as cost
             from cost_daily
             ${where ? "where "+where : ""}
             group by account_id, service, region
             order by cost desc
             limit $${p.length+1}`;
  p.push(limit);
  const { rows } = await query(q, p);
  return rows.map(r => ({
    linked_account: r.linked_account,
    service: r.service,
    region: r.region || "",
    cost: Number(r.cost||0)
  }));
}

// --- RI coverage/utilization from DB (daily totals). If no data exists, returns [].
export async function getRiCoverage({ start, end, groupBy = [] } = {}){
  const { sql, params } = whereRange(start, end);
  const where = sql;
  const q = `select day::date as date,
                    sum(coverage_hours)::float as coverage_hours,
                    sum(on_demand_hours)::float as on_demand_hours,
                    sum(reserved_hours)::float as reserved_hours,
                    sum(total_running_hours)::float as total_running_hours,
                    case when sum(total_running_hours) > 0 then (sum(reserved_hours)/sum(total_running_hours))*100.0 else 0 end as coverage_pct
             from ri_coverage_daily
             ${where}
             group by day
             order by day asc`;
  const { rows } = await query(q, params);
  return rows.map(r => ({
    date: dbDateToISO(r.date),
    attributes: {},
    coverageHours: Number(r.coverage_hours||0),
    coveragePct: Number(r.coverage_pct||0),
    onDemandHours: Number(r.on_demand_hours||0),
    reservedHours: Number(r.reserved_hours||0),
    totalRunningHours: Number(r.total_running_hours||0)
  }));
}

export async function getRiUtilization({ start, end, groupBy = [] } = {}){
  const { sql, params } = whereRange(start, end);
  const q = `select day::date as date,
                    sum(purchased_hours)::float as purchased_hours,
                    sum(total_actual_hours)::float as total_actual_hours,
                    sum(unused_hours)::float as unused_hours,
                    case when sum(total_actual_hours) > 0 then ( (sum(total_actual_hours)-sum(unused_hours))/sum(total_actual_hours) )*100.0 else 0 end as utilization_pct
             from ri_utilization_daily
             ${sql}
             group by day
             order by day asc`;
  const { rows } = await query(q, params);
  return rows.map(r => ({
    date: dbDateToISO(r.date),
    purchasedHours: Number(r.purchased_hours||0),
    totalActualHours: Number(r.total_actual_hours||0),
    unusedHours: Number(r.unused_hours||0),
    utilizationPct: Number(r.utilization_pct||0)
  }));
}

// Savings Plans placeholders (no local DB storage yet)
export async function getSpCoverage(){
  return [];
}

export async function getSpUtilization(){
  return {
    rows: [],
    summary: {
      totalCommitment: 0,
      usedCommitment: 0,
      unusedCommitment: 0,
      utilizationPct: 0,
      savings: { netSavings: 0, onDemandCostEquivalent: 0, totalSavings: 0 },
      amortizedCommitment: { total: 0, used: 0, unused: 0 },
    }
  };
}
