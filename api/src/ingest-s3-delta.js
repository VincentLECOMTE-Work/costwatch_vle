import { loadAccountsConfig } from "./config.js";
import { getBucketTimeseries } from "./s3.js";
import { query } from "./db.js";
import { S3Client, ListBucketsCommand, GetBucketLocationCommand } from "@aws-sdk/client-s3";

function makeCredentials(acc){
  if (acc && acc.accessKeyId && acc.secretAccessKey){
    return { accessKeyId: acc.accessKeyId, secretAccessKey: acc.secretAccessKey, sessionToken: acc.sessionToken || undefined };
  }
  return undefined;
}

function startOfUTCDay(d){ const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); return dt; }
function addDays(d, n){ const dt = new Date(d); dt.setUTCDate(dt.getUTCDate()+n); return dt; }

async function listBucketsWithRegion({ account }){
  const s3 = new S3Client({ region: "us-east-1", credentials: makeCredentials(account) });
  const out = await s3.send(new ListBucketsCommand({}));
  const list = [];
  for (const b of (out.Buckets || [])){
    const name = b.Name;
    let region = "us-east-1";
    try {
      const r = await s3.send(new GetBucketLocationCommand({ Bucket: name }));
      const loc = r.LocationConstraint || "us-east-1";
      region = loc === "EU" ? "eu-west-1" : (loc || "us-east-1");
    } catch {}
    list.push({ bucket: name, region });
  }
  return list;
}

async function main(){
  const cfg = loadAccountsConfig();
  const accounts = Array.isArray(cfg.static) ? cfg.static : [];
  if (accounts.length === 0) {
    console.error("[ingest:s3:delta] No static accounts configured in accounts-config.json");
    process.exit(2);
  }
  const delta = Number(process.env.DELTA_DAYS_S3 || "1");
  const today = new Date();
  const end = startOfUTCDay(today); // today 00:00Z
  const start = addDays(end, -delta); // previous day window
  console.log(`[ingest:s3:delta] Window ${start.toISOString()} -> ${end.toISOString()} (days=${delta})`);

  let inserted = 0;
  for (const acc of accounts){
    console.log(`[ingest:s3:delta] Account ${acc.accountId}`);
    let buckets = [];
    try { buckets = await listBucketsWithRegion({ account: acc }); } catch (e){ console.warn("listBuckets error", e?.message); continue; }
    for (const { bucket, region } of buckets){
      try {
        const ts = await getBucketTimeseries({ account: acc, bucket, region, start: start.toISOString(), end: end.toISOString() });
        // ts.series is an array of { t, bytes }
        const byDay = new Map();
        for (const p of (ts && Array.isArray(ts.series) ? ts.series : [])){
          const day = String(p.t || "").slice(0,10);
          const prev = byDay.get(day) || { bytes_total: 0 };
          prev.bytes_total = Number(p.bytes || 0);
          byDay.set(day, prev);
        }
        // objectsSeries
        for (const p of (ts && Array.isArray(ts.objectsSeries) ? ts.objectsSeries : [])){
          const day = String(p.t || "").slice(0,10);
          const prev = byDay.get(day) || {};
          prev.objects_total = Number(p.objects || 0);
          byDay.set(day, prev);
        }
        // seriesByClass
        const seriesByClass = (ts && ts.seriesByClass) ? ts.seriesByClass : {};
        for (const [cls, arr] of Object.entries(seriesByClass)){
          for (const p of (Array.isArray(arr) ? arr : [])){
            const day = String(p.t || "").slice(0,10);
            const prev = byDay.get(day) || {};
            if (!prev.bytes_by_class) prev.bytes_by_class = {};
            prev.bytes_by_class[cls] = Number(p.bytes || 0);
            byDay.set(day, prev);
          }
        }
        // Upsert each day
        for (const [day, rec] of byDay.entries()){
          await query(
            `insert into s3_bucket_daily (account_id, bucket, region, day, bytes_total, objects_total, bytes_by_class)
             values ($1,$2,$3,$4,$5,$6,$7)
             on conflict (account_id, region, bucket, day) do update set
               bytes_total = excluded.bytes_total,
               objects_total = excluded.objects_total,
               bytes_by_class = excluded.bytes_by_class,
               updated_at = now()`,
            [String(acc.accountId||""), bucket, region, day, Number(rec.bytes_total||0), Number(rec.objects_total||0), JSON.stringify(rec.bytes_by_class||{})]
          );
          inserted++;
        }
      } catch (e){
        console.warn(`[ingest:s3:delta] ${bucket} (${region}) failed:`, e?.message);
      }
    }
  }
  console.log(`[ingest:s3:delta] Done. Upserted ${inserted} day rows.`);
}

main().catch(e=>{ console.error("Fatal", e); process.exit(1); });
