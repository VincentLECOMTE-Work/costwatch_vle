import { ensureSchema } from "./ensure-schema.js";
import { getDailyCosts } from "./ce.js";
import { query } from "./db.js";

function arg(name, def){ const i = process.argv.indexOf("--"+name); return i>-1 ? process.argv[i+1] : def; }

const metric = arg("metric", (process.env.CE_METRICS||"UnblendedCost").split(",")[0].trim());
const start = arg("from"); const end = arg("to");
const accounts = (arg("accounts","")||"").split(",").map(s=>s.trim()).filter(Boolean);
const services = (arg("services","")||"").split(",").map(s=>s.trim()).filter(Boolean);
const includeRegion = String(process.env.INGEST_INCLUDE_REGION||"false").toLowerCase()==="true";

async function upsert(row){
  const sql = (
    "insert into cost_daily (day,account_id,service,region,metric,amount_usd,usage_quantity,updated_at) "+
    "values ($1,$2,$3,$4,$5,$6,$7, now()) "+
    "on conflict (day,account_id,service,region,metric) "+
    "do update set amount_usd=excluded.amount_usd, usage_quantity=excluded.usage_quantity, updated_at=now();"
  );
  const p = [row.date, row.accountId, row.service, row.region, row.metric, row.amountUSD, row.usageQuantity];
  await query(sql, p);
}

async function run(){
  if (!start || !end){ console.error("Missing --from/--to"); process.exit(2); }
  await ensureSchema();
  console.log(`Fetching CE daily costs (${includeRegion?'per-region':'ALL'}) from ${start} to ${end} (metric=${metric})…`);
  const rows = await getDailyCosts({ start, end, metric, includeRegion, accounts, services });
  console.log(`Fetched ${rows.length} rows, writing to DB…`);
  for (const r of rows) { await upsert(r); }
  console.log("Done.");
}
run().catch(e=>{ console.error(e); process.exit(1); });
