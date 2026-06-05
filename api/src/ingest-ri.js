
import { ensureSchema } from "./ensure-schema.js";
import { getRiCoverage, getRiUtilization } from "./ce-aws.js";
import { query } from "./db.js";

function arg(name, def){ const i = process.argv.indexOf("--"+name); return i>-1 ? process.argv[i+1] : def; }
const start = arg("from");
const end   = arg("to");

async function upsertCoverage(row){
  const sql = `
    insert into ri_coverage_daily (day, coverage_hours, on_demand_hours, reserved_hours, total_running_hours, updated_at)
    values ($1,$2,$3,$4,$5, now())
    on conflict (day) do update set
      coverage_hours = excluded.coverage_hours,
      on_demand_hours = excluded.on_demand_hours,
      reserved_hours = excluded.reserved_hours,
      total_running_hours = excluded.total_running_hours,
      updated_at = now()
  `;
  const p = [row.date, row.coverageHours || 0, row.onDemandHours || 0, row.reservedHours || 0, row.totalRunningHours || 0];
  await query(sql, p);
}

async function upsertUtil(row){
  const sql = `
    insert into ri_utilization_daily (day, purchased_hours, total_actual_hours, unused_hours, updated_at)
    values ($1,$2,$3,$4, now())
    on conflict (day) do update set
      purchased_hours = excluded.purchased_hours,
      total_actual_hours = excluded.total_actual_hours,
      unused_hours = excluded.unused_hours,
      updated_at = now()
  `;
  const p = [row.date, row.purchasedHours || 0, row.totalActualHours || 0, row.unusedHours || 0];
  await query(sql, p);
}

async function run(){
  if (!start || !end){ console.error("Missing --from/--to"); process.exit(2); }
  await ensureSchema();
  console.log(`Fetching RI coverage ${start}..${end}`);
  const covRows = await getRiCoverage({ start, end });
  for (const r of covRows) await upsertCoverage(r);
  console.log(`Fetching RI utilization ${start}..${end}`);
  const utilRows = await getRiUtilization({ start, end });
  for (const r of utilRows) await upsertUtil(r);
  console.log("RI ingest done.");
}
run().catch(e=>{ console.error(e); process.exit(1); });
