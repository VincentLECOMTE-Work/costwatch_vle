import { spawn } from "node:child_process";
import { ensureSchema } from "./ensure-schema.js";
import { query } from "./db.js";
import { computeAutoIngestWindow, isoDate } from "./ingest-window.js";

function arg(name, fallback = undefined) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx > -1 ? process.argv[idx + 1] : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function asBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const v = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(v)) return true;
  if (["0", "false", "no", "n", "off"].includes(v)) return false;
  return fallback;
}

function asNonNegativeInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function dayToIso(day) {
  if (!day) return null;
  const d = day instanceof Date ? day : new Date(day);
  if (Number.isNaN(d.getTime())) return null;
  return isoDate(d);
}

async function runNode(script, args = []) {
  await new Promise((resolve, reject) => {
    const cp = spawn("node", [script, ...args], { stdio: "inherit" });
    cp.on("close", (code) => {
      if (code === 0) return resolve();
      return reject(new Error(`node ${script} ${args.join(" ")} failed with code ${code}`));
    });
  });
}

async function loadMetricMaxDays(metrics) {
  const { rows } = await query(
    `with requested as (
       select unnest($1::text[]) as metric
     )
     select r.metric, max(c.day)::date as max_day
       from requested r
       left join cost_daily c on c.metric = r.metric
      group by r.metric
      order by r.metric asc`,
    [metrics]
  );
  const out = {};
  for (const row of rows) {
    out[row.metric] = dayToIso(row.max_day);
  }
  for (const metric of metrics) {
    if (!(metric in out)) out[metric] = null;
  }
  return out;
}

async function loadMissingSummary(metrics, fromInclusive, toInclusive) {
  if (!fromInclusive || !toInclusive) return { lastMissingDay: null, missingPoints: 0 };
  const { rows } = await query(
    `with metrics as (
       select unnest($1::text[]) as metric
     ),
     days as (
       select generate_series($2::date, $3::date, interval '1 day')::date as day
     ),
     expected as (
       select d.day, m.metric
         from days d
         cross join metrics m
     ),
     present as (
       select distinct day, metric
         from cost_daily
        where metric = any($1::text[])
          and day between $2::date and $3::date
     ),
     missing as (
       select e.day, e.metric
         from expected e
         left join present p on p.day = e.day and p.metric = e.metric
        where p.day is null
     )
     select max(day)::date as last_missing_day,
            count(*)::int as missing_points
       from missing`,
    [metrics, fromInclusive, toInclusive]
  );
  const row = rows?.[0] || {};
  return {
    lastMissingDay: dayToIso(row.last_missing_day),
    missingPoints: Number(row.missing_points || 0)
  };
}

function printOverview(plan, metrics, metricMaxDays, missing) {
  console.log("");
  console.log("[ingest:auto] Overview");
  console.log(`- mode: ${plan.mode}`);
  console.log(`- metrics: ${metrics.join(", ")}`);
  console.log(`- target day (inclusive): ${plan.toInclusive}`);
  console.log(`- computed --from: ${plan.fromInclusive}`);
  console.log(`- computed --to (exclusive): ${plan.toExclusive}`);
  console.log(`- overlap days: ${plan.overlapDays}`);
  console.log(`- lag days: ${plan.lagDays}`);
  console.log(`- missing metric/day points in window: ${missing.missingPoints}`);
  console.log(`- last missing day in window: ${missing.lastMissingDay || "none"}`);
  console.log("");
  console.log("[ingest:auto] Current max day by metric");
  for (const metric of metrics) {
    console.log(`- ${metric}: ${metricMaxDays[metric] || "none"}`);
  }
  console.log("");
}

async function main() {
  const metrics = (process.env.CE_METRICS || "UnblendedCost")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  if (!metrics.length) {
    throw new Error("No metrics configured. Set CE_METRICS or keep default UnblendedCost.");
  }

  const lagDays = asNonNegativeInt(arg("lag-days", process.env.INGEST_LAG_DAYS), 2);
  const overlapDays = asNonNegativeInt(arg("overlap-days", process.env.INGEST_OVERLAP_DAYS), 1);
  const bootstrapDays = asNonNegativeInt(arg("bootstrap-days", process.env.INGEST_BOOTSTRAP_DAYS), 30);
  const dryRun = hasFlag("dry-run");
  const warmSpCache = asBool(process.env.INGEST_SP_CACHE_WARM, true) && !hasFlag("skip-sp-cache");

  await ensureSchema();
  const metricMaxDays = await loadMetricMaxDays(metrics);
  const plan = computeAutoIngestWindow({
    lagDays,
    overlapDays,
    bootstrapDays,
    metricMaxDays
  });
  const missing = await loadMissingSummary(metrics, plan.fromInclusive, plan.toInclusive);

  printOverview(plan, metrics, metricMaxDays, missing);
  if (!plan.shouldIngest) {
    console.log("[ingest:auto] Nothing to ingest: range is empty for current lag/overlap values.");
    return;
  }
  if (dryRun) {
    console.log("[ingest:auto] Dry run enabled, ingest command skipped.");
    return;
  }

  await runNode("src/ingest-metrics-all.js", ["--from", plan.fromInclusive, "--to", plan.toExclusive]);
  if (warmSpCache) {
    await runNode("src/ingest-sp-cache.js", ["--from", plan.fromInclusive, "--to", plan.toExclusive]);
  }

  const metricMaxDaysAfter = await loadMetricMaxDays(metrics);
  console.log("[ingest:auto] Max day by metric after ingest");
  for (const metric of metrics) {
    console.log(`- ${metric}: ${metricMaxDaysAfter[metric] || "none"}`);
  }
}

main().catch((err) => {
  console.error("[ingest:auto] Failed", err);
  process.exit(1);
});
